/**
 * Cloudflare Worker: Telegram webhook for the X→Telegram digest bot.
 *
 * Handles user commands (config stored as users.json in the GitHub repo)
 * and the ✅ Post button (copies the approved preview into the user's channel).
 *
 * Secrets to set on the Worker (Settings → Variables → Secrets):
 *   BOT_TOKEN       — from @BotFather
 *   GH_TOKEN        — fine-grained GitHub PAT, Contents read/write on the repo
 *   GH_REPO         — "owner/repo"
 *   WEBHOOK_SECRET  — any random string; also passed to setWebhook
 *
 * Plain variables (not secret):
 *   BOT_USERNAME    — bot username without @, used by the landing page CTA
 *   ADMIN_USERNAME  — Telegram username (without @) that gets admin commands
 *   ADMIN_ID        — optional but recommended: admin's numeric Telegram id
 *                     (usernames can be released and re-claimed; ids cannot)
 *
 * GET requests serve the landing page (plus /robots.txt and /sitemap.xml);
 * POST requests are the Telegram webhook.
 */

const HELP = `X → Telegram digest bot

Setup:
/channel @yourchannel — where approved posts go (add me as channel admin with "Post messages" first; for a private channel, forward me any message from it instead)
/add handle1 handle2 — X accounts to watch
/times 9,18 — hours (0-23) you want digests, in your timezone
/timezone Europe/Kyiv — your IANA timezone

Tuning:
/lang en|uk|ru — language of generated posts (default: en)
/remove handle — stop watching an account
/list — show watched accounts
/limit 3 — max posts proposed per digest (1-5)
/interests crypto, AI research — what counts as interesting for you
/style short punchy Ukrainian summaries — how captions should be written
/settings — show your current config
/id — show your numeric Telegram id`;

const ADMIN_HELP = `

Admin:
/whitelist <id> — give a user pro limits for free
/unwhitelist <id> — revoke
/whitelisted — list whitelisted ids
/users — list all registered users
/gen_digest_now — run your digest immediately (testing)`;

// Free vs pro limits. Whitelisted users (and the admin) get pro; later,
// paying users plug into the same check.
const LIMITS = {
  free: { sources: 5, hours: 1 },
  pro: { sources: 25, hours: 6 },
};

function isAdminUser(from, env) {
  if (!from) return false;
  if (env.ADMIN_ID && String(from.id) === String(env.ADMIN_ID)) return true;
  return !!(env.ADMIN_USERNAME && from.username &&
    from.username.toLowerCase() === env.ADMIN_USERNAME.replace(/^@/, "").toLowerCase());
}

function limitsFor(config, chatId, isAdmin) {
  const pro = isAdmin || (config.whitelist || []).includes(String(chatId));
  return LIMITS[pro ? "pro" : "free"];
}

/** Warn about missing setup steps — digests silently skip incomplete users. */
function setupHints({ channel, sources }) {
  const missing = [];
  if (!channel) missing.push("• /channel — where approved posts go");
  if (!sources?.length) missing.push("• /add — X accounts to watch");
  return missing.length
    ? "\n\n⚠️ Digests won't start until you also set:\n" + missing.join("\n")
    : "";
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return serveSite(request, env);
    if (request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("ok");
    }
    try {
      if (update.callback_query) await handleCallback(update.callback_query, env);
      else if (update.message) await handleMessage(update.message, env);
    } catch (err) {
      console.log("handler error:", err.stack || err);
    }
    return new Response("ok"); // always 200 so Telegram doesn't retry-storm
  },
};

/* ---------------- Telegram helpers ---------------- */

async function tg(env, method, params) {
  const resp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await resp.json();
  if (!data.ok) console.log(`${method} failed: ${data.description}`);
  return data;
}

const reply = (env, chatId, text) => tg(env, "sendMessage", { chat_id: chatId, text });

/* ---------------- GitHub-backed config ---------------- */

function ghHeaders(env) {
  return {
    authorization: `Bearer ${env.GH_TOKEN}`,
    accept: "application/vnd.github+json",
    "user-agent": "xdigest-worker",
  };
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function loadConfig(env) {
  const resp = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/contents/users.json`,
    { headers: ghHeaders(env) },
  );
  if (!resp.ok) throw new Error(`config load failed: ${resp.status}`);
  const file = await resp.json();
  return { config: JSON.parse(b64decode(file.content)), sha: file.sha };
}

async function saveConfig(env, config, sha) {
  const resp = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/contents/users.json`,
    {
      method: "PUT",
      headers: ghHeaders(env),
      body: JSON.stringify({
        message: "bot: update user config",
        content: b64encode(JSON.stringify(config, null, 2) + "\n"),
        sha,
      }),
    },
  );
  if (!resp.ok) throw new Error(`config save failed: ${resp.status}`);
}

/* ---------------- Commands ---------------- */

function userDefaults() {
  return { channel: null, sources: [], hours: [9], timezone: null,
           limit: 3, interests: null, style: null, language: "en" };
}

async function handleMessage(msg, env) {
  if (msg.chat.type !== "private") return;
  const chatId = msg.chat.id;

  // Forwarded from a private channel → capture its numeric id as the target.
  const fwd = msg.forward_origin;
  if (fwd?.type === "channel") {
    await setField(env, chatId, (u) => { u.channel = fwd.chat.id; },
      `Channel set to "${fwd.chat.title}" (${fwd.chat.id}). ` +
      `Make sure I'm an admin there with "Post messages" permission.`);
    return;
  }

  if (!msg.text) return;
  const [rawCmd, ...rest] = msg.text.trim().split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const arg = rest.join(" ").trim();
  const isAdmin = isAdminUser(msg.from, env);

  switch (cmd) {
    case "/start":
    case "/help":
      return reply(env, chatId, HELP + (isAdmin ? ADMIN_HELP : ""));

    case "/id":
      return reply(env, chatId, `Your id: ${msg.from.id}`);

    case "/channel": {
      if (!/^@[a-zA-Z0-9_]{4,}$/.test(arg) && !/^-100\d+$/.test(arg)) {
        return reply(env, chatId,
          "Usage: /channel @yourchannel\n(or forward me a message from a private channel)");
      }
      const value = arg.startsWith("@") ? arg : Number(arg);
      const { config } = await loadConfig(env);
      const u0 = config.users?.[String(chatId)];
      return setField(env, chatId, (u) => { u.channel = value; },
        `Channel set to ${arg}. Make sure I'm an admin there with "Post messages" permission.` +
        setupHints({ channel: value, sources: u0?.sources }));
    }

    case "/add": {
      const handles = arg.split(/[,\s@]+/).map((h) => h.toLowerCase())
        .filter((h) => /^[a-z0-9_]{1,15}$/.test(h));
      if (!handles.length) return reply(env, chatId, "Usage: /add naval pmarca");
      const { config } = await loadConfig(env);
      const max = limitsFor(config, chatId, isAdmin).sources;
      const current = config.users?.[String(chatId)]?.sources || [];
      const merged = [...new Set([...current, ...handles])];
      if (merged.length > max) {
        return reply(env, chatId,
          `Your plan includes up to ${max} accounts (you'd have ${merged.length}).`);
      }
      return setField(env, chatId, (u) => {
        u.sources = [...new Set([...u.sources, ...handles])].slice(0, max);
      }, `Now watching: ${handles.map((h) => "@" + h).join(", ")}` +
         setupHints({ channel: config.users?.[String(chatId)]?.channel, sources: merged }));
    }

    case "/remove": {
      const handle = arg.replace(/^@/, "").toLowerCase();
      return setField(env, chatId, (u) => {
        u.sources = u.sources.filter((s) => s !== handle);
      }, `Removed @${handle}`);
    }

    case "/list": {
      const { config } = await loadConfig(env);
      const u = config.users[String(chatId)];
      return reply(env, chatId,
        u?.sources?.length ? u.sources.map((s) => "@" + s).join("\n") : "No sources yet. /add some!");
    }

    case "/times": {
      const hours = [...new Set(arg.split(/[,\s]+/).map(Number)
        .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b);
      if (!hours.length) return reply(env, chatId, "Usage: /times 9,18");
      const { config } = await loadConfig(env);
      const max = limitsFor(config, chatId, isAdmin).hours;
      if (hours.length > max) {
        return reply(env, chatId, `Your plan includes up to ${max} digest time(s) per day.`);
      }
      const u0 = config.users?.[String(chatId)];
      return setField(env, chatId, (u) => { u.hours = hours; },
        `Digests at: ${hours.map((h) => h + ":00").join(", ")} (your timezone)` +
        setupHints({ channel: u0?.channel, sources: u0?.sources }));
    }

    case "/timezone": {
      if (!/^[A-Za-z_]+\/[A-Za-z_+-]+$/.test(arg)) {
        return reply(env, chatId, "Usage: /timezone Europe/Kyiv (IANA name)");
      }
      return setField(env, chatId, (u) => { u.timezone = arg; }, `Timezone set to ${arg}`);
    }

    case "/limit": {
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 1 || n > 5) return reply(env, chatId, "Usage: /limit 3 (1-5)");
      return setField(env, chatId, (u) => { u.limit = n; }, `Up to ${n} posts per digest.`);
    }

    case "/lang":
    case "/language": {
      const lang = arg.toLowerCase();
      if (!["en", "uk", "ru"].includes(lang)) {
        return reply(env, chatId, "Usage: /lang en | uk | ru");
      }
      const names = { en: "English", uk: "Ukrainian", ru: "Russian" };
      return setField(env, chatId, (u) => { u.language = lang; },
        `Posts will be written in ${names[lang]}.`);
    }

    case "/interests":
      return setField(env, chatId, (u) => { u.interests = arg || null; },
        arg ? "Interests saved." : "Interests cleared.");

    case "/style":
      return setField(env, chatId, (u) => { u.style = arg || null; },
        arg ? "Caption style saved." : "Caption style cleared.");

    case "/settings": {
      const { config } = await loadConfig(env);
      const u = config.users[String(chatId)] || userDefaults();
      const pro = isAdmin || (config.whitelist || []).includes(String(chatId));
      return reply(env, chatId,
        JSON.stringify(u, null, 2) + `\n\nPlan: ${pro ? "pro" : "free"}`);
    }

    case "/whitelist":
    case "/unwhitelist": {
      if (!isAdmin) return reply(env, chatId, "Unknown command. /help");
      if (!/^\d+$/.test(arg)) {
        return reply(env, chatId,
          `Usage: ${cmd} <numeric id>\n(the user can get theirs with /id)`);
      }
      const adding = cmd === "/whitelist";
      return mutateConfig(env, chatId, (config) => {
        const list = new Set(config.whitelist || []);
        adding ? list.add(arg) : list.delete(arg);
        config.whitelist = [...list].sort();
      }, adding ? `Whitelisted ${arg} — they now have pro limits.` : `Removed ${arg} from the whitelist.`);
    }

    case "/whitelisted": {
      if (!isAdmin) return reply(env, chatId, "Unknown command. /help");
      const { config } = await loadConfig(env);
      const list = config.whitelist || [];
      return reply(env, chatId, list.length ? list.join("\n") : "Whitelist is empty.");
    }

    case "/gen_digest_now": {
      if (!isAdmin) return reply(env, chatId, "Unknown command. /help");
      const resp = await fetch(
        `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/digest.yml/dispatches`,
        {
          method: "POST",
          headers: ghHeaders(env),
          body: JSON.stringify({ ref: "main", inputs: { only_user: String(chatId) } }),
        },
      );
      if (resp.status !== 204) {
        const detail = await resp.text();
        console.log("dispatch failed:", resp.status, detail);
        return reply(env, chatId,
          `Couldn't start the workflow (HTTP ${resp.status}). ` +
          `Check that GH_TOKEN has "Actions: Read and write" permission.`);
      }
      return reply(env, chatId,
        "Digest started 🚀 GitHub needs ~1–2 min to spin up; previews will arrive here.");
    }

    case "/users": {
      if (!isAdmin) return reply(env, chatId, "Unknown command. /help");
      const { config } = await loadConfig(env);
      const lines = Object.entries(config.users || {}).map(([id, u]) =>
        `${id} → ${u.channel || "no channel"}, ${u.sources.length} sources, ` +
        `${(u.hours || []).length} time(s)/day`);
      return reply(env, chatId, lines.length ? lines.join("\n") : "No users yet.");
    }

    default:
      return reply(env, chatId, "Unknown command. /help");
  }
}

/** Mutate top-level config (whitelist etc.) with one retry on sha conflicts. */
async function mutateConfig(env, chatId, mutate, confirmation) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { config, sha } = await loadConfig(env);
    config.users ||= {};
    mutate(config);
    try {
      await saveConfig(env, config, sha);
      return reply(env, chatId, confirmation);
    } catch (err) {
      if (attempt === 1) {
        console.log("config save failed twice:", err);
        return reply(env, chatId, "Storage hiccup, please try again.");
      }
    }
  }
}

async function setField(env, chatId, mutate, confirmation) {
  // One retry in case of a concurrent commit (sha conflict).
  for (let attempt = 0; attempt < 2; attempt++) {
    const { config, sha } = await loadConfig(env);
    config.users ||= {};
    const user = (config.users[String(chatId)] ||= userDefaults());
    mutate(user);
    try {
      await saveConfig(env, config, sha);
      return reply(env, chatId, confirmation);
    } catch (err) {
      if (attempt === 1) {
        console.log("config save failed twice:", err);
        return reply(env, chatId, "Storage hiccup, please try again.");
      }
    }
  }
}

/* ---------------- One-click publish ---------------- */

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const controlId = cb.message.message_id;
  const answer = (text, alert = false) =>
    tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert });

  if (cb.data === "s") {
    await tg(env, "editMessageText",
      { chat_id: chatId, message_id: controlId, text: "❌ Skipped" });
    return answer("Skipped");
  }

  if (cb.data.startsWith("p:")) {
    const ids = cb.data.slice(2).split(",").map(Number).sort((a, b) => a - b);
    const { config } = await loadConfig(env);
    const user = config.users?.[String(chatId)];
    if (!user?.channel) return answer("Set your channel first: /channel @name", true);

    // Future non-Telegram targets (e.g. Instagram) would branch here into a
    // GitHub workflow_dispatch instead of copyMessages.
    const result = await tg(env, "copyMessages", {
      chat_id: user.channel,
      from_chat_id: chatId,
      message_ids: ids,
    });
    if (!result.ok) {
      return answer(`Failed: ${result.description}. Am I an admin of ${user.channel}?`, true);
    }
    await tg(env, "editMessageText",
      { chat_id: chatId, message_id: controlId, text: `✅ Posted to ${user.channel}` });
    return answer("Posted!");
  }

  return answer("");
}

/* ---------------- Landing page (GET requests) ---------------- */

function serveSite(request, env) {
  const url = new URL(request.url);
  const origin = url.origin;

  if (url.pathname === "/robots.txt") {
    return new Response(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, {
      headers: { "content-type": "text/plain" },
    });
  }
  if (url.pathname === "/sitemap.xml") {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc><changefreq>weekly</changefreq></url>
</urlset>`;
    return new Response(xml, { headers: { "content-type": "application/xml" } });
  }
  if (url.pathname !== "/") {
    return Response.redirect(origin + "/", 301);
  }
  return new Response(landingHTML(origin, env.BOT_USERNAME || ""), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

function landingHTML(origin, botUser) {
  const botLink = botUser ? `https://t.me/${botUser}` : "#";
  const title = "XDigest — auto-post the best tweets to your Telegram channel";
  const description =
    "Telegram bot that watches X (Twitter) accounts, picks the most interesting " +
    "posts with AI and publishes them to your channel in one tap. Free to start.";

  const faq = [
    ["How does XDigest post to my channel?",
     "You add the bot as an administrator of your channel with the single " +
     "permission to post messages. Nothing else is required — no passwords, no API keys."],
    ["Do I need a server or any technical setup?",
     "No. You send the bot a list of X accounts and the hours you want digests. Everything else is automatic."],
    ["How does it choose which tweets to repost?",
     "It shortlists new posts by engagement, then an AI model ranks them against " +
     "your stated interests and writes a caption in your channel's style. You approve every post before it goes out."],
    ["Is it free?",
     "The core is free while in early access. Higher digest frequency and more watched accounts will be paid plans."],
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: "XDigest",
        applicationCategory: "UtilitiesApplication",
        operatingSystem: "Telegram",
        url: origin + "/",
        description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      },
      {
        "@type": "FAQPage",
        mainEntity: faq.map(([q, a]) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      },
    ],
  };

  const faqHTML = faq
    .map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${origin}/">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${origin}/">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<meta name="theme-color" content="#0e1621">
<style>
  :root { --bg:#0e1621; --surface:#17212b; --line:#243342; --ink:#e7edf3;
          --muted:#8b98a5; --accent:#2aabee; --accent2:#229ed9; }
  * { box-sizing:border-box; margin:0; }
  body { font:16px/1.65 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
         background:var(--bg); color:var(--ink); }
  main { max-width:720px; margin:0 auto; padding:64px 20px 80px; }
  .badge { display:inline-block; font-size:.78rem; font-weight:600; letter-spacing:.08em;
           text-transform:uppercase; color:var(--accent); background:var(--surface);
           border:1px solid var(--line); border-radius:999px; padding:5px 14px; }
  h1 { font-size:2.5rem; line-height:1.15; margin:22px 0 16px; font-weight:800;
       letter-spacing:-.02em; }
  em { color:var(--accent); font-style:normal; }
  p.lead { font-size:1.12rem; color:var(--muted); }
  .cta { display:inline-block; margin:30px 0 6px; padding:15px 30px;
         background:linear-gradient(135deg,var(--accent),var(--accent2));
         color:#fff; text-decoration:none; font-weight:600; font-size:1.02rem;
         border-radius:10px; box-shadow:0 6px 24px rgba(42,171,238,.30); }
  .cta:hover { filter:brightness(1.1); }
  .hint { font-size:.85rem; color:var(--muted); }
  h2 { font-size:1.3rem; margin:56px 0 18px; padding-left:12px;
       border-left:3px solid var(--accent); }
  ol.steps { list-style:none; padding:0; counter-reset:step; }
  ol.steps li { counter-increment:step; margin:12px 0; padding:14px 16px 14px 56px;
                position:relative; background:var(--surface);
                border:1px solid var(--line); border-radius:12px; }
  ol.steps li::before { content:counter(step); position:absolute; left:16px; top:50%;
       transform:translateY(-50%); width:26px; height:26px; border-radius:50%;
       background:rgba(42,171,238,.15); color:var(--accent); font-weight:700;
       display:flex; align-items:center; justify-content:center; font-size:.88rem; }
  code { font-family:ui-monospace,Consolas,monospace; background:#1c2733;
         color:#7fd0ff; padding:2px 8px; border-radius:6px; font-size:.9em; }
  ul.features { list-style:none; padding:0; }
  ul.features li { margin:10px 0; padding:12px 16px 12px 44px; position:relative;
                   background:var(--surface); border:1px solid var(--line);
                   border-radius:12px; }
  ul.features li::before { content:"✓"; position:absolute; left:17px;
                           color:var(--accent); font-weight:700; }
  details { background:var(--surface); border:1px solid var(--line);
            border-radius:12px; padding:14px 18px; margin:10px 0; }
  summary { cursor:pointer; font-weight:600; }
  details p { margin-top:10px; color:var(--muted); }
  a { color:var(--accent); }
  footer { margin-top:72px; padding-top:20px; border-top:1px solid var(--line);
           font-size:.85rem; color:var(--muted); }
</style>
</head>
<body>
<main>
  <span class="badge">Telegram bot · free early access</span>
  <h1>Your Telegram channel, fed by the <em>best</em> of X — automatically</h1>
  <p class="lead">XDigest watches the X (Twitter) accounts you choose, picks the
  posts worth reposting and sends them to you at the hours you set. One tap —
  published to your channel, media and caption included.</p>
  <a class="cta" href="${botLink}">Open the bot in Telegram →</a>
  <p class="hint">No passwords, no API keys — you approve every post.</p>

  <h2>How it works</h2>
  <ol class="steps">
    <li>Tell the bot which X accounts to watch: <code>/add naval pmarca</code></li>
    <li>Set your digest hours: <code>/times 9,18</code></li>
    <li>Add the bot as admin of your channel</li>
    <li>Get previews, tap ✅ — the post is in your channel in a second</li>
  </ol>

  <h2>Why channel admins use it</h2>
  <ul class="features">
    <li>AI curation — it ranks new posts by engagement <em>and</em> your interests, not just recency</li>
    <li>Captions written in your channel's own style and language</li>
    <li>You approve everything — nothing is ever posted without your tap</li>
    <li>Photos and videos come through natively, not as screenshots</li>
    <li>No passwords, no API keys, no server — a two-minute setup</li>
  </ul>

  <h2>Questions</h2>
  ${faqHTML}

  <footer>XDigest · <a href="${botLink}">@${botUser || "the bot"}</a> ·
  posts only what you approve</footer>
</main>
</body>
</html>`;
}
