/**
 * Cloudflare Worker: Telegram webhook for the X→Telegram digest bot.
 *
 * Handles user commands (config stored in Upstash Redis, shared with the
 * GitHub Actions pipeline) and the ✅ Post button (copies the approved
 * preview into the user's channel).
 *
 * Secrets to set on the Worker (Settings → Variables → Secrets):
 *   BOT_TOKEN       — from @BotFather
 *   GH_TOKEN        — fine-grained GitHub PAT, Actions read/write on the repo
 *                     (used only to dispatch the digest workflow)
 *   GH_REPO         — "owner/repo"
 *   WEBHOOK_SECRET  — any random string; also passed to setWebhook
 *   UPSTASH_REDIS_REST_URL   — from the Upstash console (REST API section)
 *   UPSTASH_REDIS_REST_TOKEN — ditto
 *
 * Plain variables (not secret):
 *   BOT_USERNAME    — bot username without @, used by the landing page CTA
 *   ADMIN_USERNAME  — Telegram username (without @) that gets admin commands
 *   ADMIN_ID        — optional but recommended: admin's numeric Telegram id
 *                     (usernames can be released and re-claimed; ids cannot)
 *   PRO_PRICE_STARS — monthly Pro price in Telegram Stars (default 550)
 *
 * GET requests serve the landing page (plus /robots.txt and /sitemap.xml);
 * POST requests are the Telegram webhook.
 */

const HELP = `🤖 XGist — the gist of X, straight to your Telegram channel

Setup — 3 steps:

1️⃣ /channel @yourchannel — connect your channel
(first add me as its admin with the "Post messages" permission; private channel? just forward me any message from it)

2️⃣ /add @naval @pmarca — X (Twitter) accounts to watch (up to 5 free · 25 with Pro)

3️⃣ /schedule 9,18 — hours (0-23) when I bring you a digest (1 time/day free · 6 with Pro)

At those hours you'll get previews here. Tap ✅ Post — it's in your channel. Tap ❌ Skip — nobody ever sees it. Tap ✏️ Edit to rewrite the text or swap the images before posting. Tap 🫥 Spoiler to blur the media and text. Tap 🕐 Schedule to publish at a later hour instead of right away.

Fine-tuning:
🌐 /lang en | uk | ru — post language (default: en)
✍️ /post_style short, witty, no emoji — how to write captions
📋 /list — accounts you watch
🗑 /remove @handle — stop watching one
🔢 /limit 3 — max posts per digest (1-5)
🌍 /timezone Europe/Kyiv — your timezone
⚙️ /settings — your current setup
🆔 /id — your Telegram id
⭐ /pro — up to 6 digests/day and 25 accounts
📮 /feedback — tell the maker anything`;

const ADMIN_HELP = `

Admin:
/whitelist 123456789 — give a user pro limits for free (id from their /id)
/unwhitelist 123456789 — revoke
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

function hasPaidPro(user) {
  return !!(user?.paid_until && Date.parse(user.paid_until) > Date.now());
}

// Early-access gift: the first PROMO_SLOTS users to /start get a free month
// of Pro. Grant ids are tracked in the "promo" Redis set so slots are never
// reused (SADD returning 0 means this id already claimed one).
const PROMO_SLOTS = 50;

async function maybeGrantPromo(env, chatId) {
  const id = String(chatId);
  try {
    if ((await redis(env, "SCARD", "promo")) >= PROMO_SLOTS) return false;
    const user = await loadUser(env, chatId);
    if (hasPaidPro(user) || (await isWhitelisted(env, chatId))) return false;
    if ((await redis(env, "SADD", "promo", id)) !== 1) return false;
    const entry = user || userDefaults();
    entry.paid_until = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    await saveUser(env, chatId, entry);
    return true;
  } catch (err) {
    console.log("promo grant failed:", err);
    return false;
  }
}

async function limitsFor(env, chatId, user, isAdmin) {
  const pro = isAdmin || hasPaidPro(user) || (await isWhitelisted(env, chatId));
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
  async fetch(request, env, ctx) {
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
      if (update.pre_checkout_query) {
        // Mandatory payment handshake — must be answered within 10 seconds.
        await tg(env, "answerPreCheckoutQuery", {
          pre_checkout_query_id: update.pre_checkout_query.id,
          ok: true,
        });
      } else if (update.callback_query) await handleCallback(update.callback_query, env);
      else if (update.message) await handleMessage(update.message, env, ctx);
    } catch (err) {
      console.log("handler error:", err.stack || err);
    }
    return new Response("ok"); // always 200 so Telegram doesn't retry-storm
  },

  // Cloudflare Cron Trigger (Worker → Settings → Triggers → add "0 * * * *").
  // GitHub's own schedule silently drops hourly slots, so the Worker kicks
  // each run via workflow_dispatch — those execute promptly and reliably.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      fetch(
        `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/digest.yml/dispatches`,
        {
          method: "POST",
          headers: ghHeaders(env),
          body: JSON.stringify({ ref: "main", inputs: {} }),
        },
      ).then(async (resp) => {
        if (resp.status !== 204) {
          console.log("cron dispatch failed:", resp.status, await resp.text());
        }
      }),
      publishScheduled(env),
    ]));
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

// All bot replies use HTML parse mode; escape any user-provided text with esc().
// If Telegram rejects the HTML (stray < or &), fall back to plain text rather
// than silently sending nothing.
async function reply(env, chatId, text, extra = {}) {
  const params = {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    ...extra,
  };
  const res = await tg(env, "sendMessage", { ...params, parse_mode: "HTML" });
  if (!res.ok && /parse/i.test(res.description || "")) {
    return tg(env, "sendMessage", params);
  }
  return res;
}

// Persistent menu keyboard; button taps are mapped back to commands below.
const MENU = {
  keyboard: [
    [{ text: "⚙️ Settings" }, { text: "📋 My accounts" }],
    [{ text: "❓ Help" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
const MENU_BUTTONS = {
  "⚙️ Settings": "/settings",
  "📋 My accounts": "/list",
  "❓ Help": "/help",
};

// Registered in Telegram's "/" autocomplete via GET /setup-commands?key=<WEBHOOK_SECRET>
const COMMANDS = [
  ["channel", "connect your channel: @name"],
  ["add", "watch X accounts: @naval @pmarca"],
  ["schedule", "digest hours: 9,18"],
  ["lang", "post language: en | uk | ru"],
  ["post_style", "how to write captions"],
  ["list", "accounts you watch"],
  ["remove", "stop watching: @handle"],
  ["limit", "posts per digest: 1-5"],
  ["timezone", "e.g. Europe/Kyiv"],
  ["settings", "your current setup"],
  ["pro", "upgrade to Pro ⭐"],
  ["feedback", "message the maker"],
  ["help", "how it all works"],
];
const ADMIN_COMMANDS = [
  ["gen_digest_now", "run your digest now (admin)"],
  ["whitelist", "grant pro to an id (admin)"],
  ["unwhitelist", "revoke pro (admin)"],
  ["whitelisted", "list whitelisted ids (admin)"],
  ["users", "list all users (admin)"],
];

async function setupCommands(env) {
  const toApi = (pairs) => pairs.map(([command, description]) => ({ command, description }));
  const results = [await tg(env, "setMyCommands", { commands: toApi(COMMANDS) })];
  if (env.ADMIN_ID) {
    results.push(await tg(env, "setMyCommands", {
      commands: toApi([...COMMANDS, ...ADMIN_COMMANDS]),
      scope: { type: "chat", chat_id: Number(env.ADMIN_ID) },
    }));
  }
  return results;
}

const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Mirror of format_caption in pipeline/caption.py — keep the two in sync.
// Wraps quoted passages of MIN_QUOTE_WORDS+ words in <blockquote> so text
// sent via ✏️ Edit is formatted the same way as digest-generated captions.
// Each quote style only closes with its own pair, so a nested quote of
// another style («… "…" …») can't cut the outer one short.
const QUOTE_RE = /«([^«»]+)»|“([^“”]+)”|"([^"]+)"/g;
const MIN_QUOTE_WORDS = 6;

function formatCaption(text) {
  const parts = [];
  let lastEnd = 0;
  for (const m of text.matchAll(QUOTE_RE)) {
    const inner = m[1] ?? m[2] ?? m[3];
    if (inner.trim().split(/\s+/).length < MIN_QUOTE_WORDS) continue;
    const before = text.slice(lastEnd, m.index).replace(/[:— \n]+$/, "").trim();
    if (before) parts.push(esc(before));
    // Keep the quote marks: the blockquote styles the passage, the marks
    // still signal it's a citation.
    parts.push(`<blockquote>${esc(m[0].trim())}</blockquote>`);
    lastEnd = m.index + m[0].length;
  }
  const after = text.slice(lastEnd).replace(/^[.,!? \n]+/, "").trim();
  if (after) parts.push(esc(after));
  return parts.join("\n\n");
}

// Link an X handle to x.com — a bare @handle in a message would render as a
// (wrong) Telegram profile link.
const xlink = (h) => `<a href="https://x.com/${h}">@${h}</a>`;

/* ---------------- Redis-backed storage (Upstash) ----------------
 * Keys, shared with pipeline/config.py — keep the two in sync:
 *   user:<id>     — JSON user config (channel, sources, hours, editing, …)
 *   uids          — set of registered user ids
 *   whitelist     — set of ids with free Pro
 *   promo         — set of ids that claimed the early-access month
 *   state:<id>    — JSON per-user pipeline state (pending previews, last run)
 *   feedback:<id> — list of JSON ✅/❌ verdicts, oldest first, trimmed to 30
 *   sched         — hash <chatId>:<controlId> → JSON scheduled-publish job
 */

async function redis(env, ...cmd) {
  const resp = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
    body: JSON.stringify(cmd),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`redis ${cmd[0]} failed: ${data.error}`);
  return data.result;
}

async function getJson(env, key) {
  const raw = await redis(env, "GET", key);
  return raw ? JSON.parse(raw) : null;
}

const setJson = (env, key, value) =>
  redis(env, "SET", key, JSON.stringify(value));

const loadUser = (env, chatId) => getJson(env, `user:${chatId}`);

async function saveUser(env, chatId, user) {
  await setJson(env, `user:${chatId}`, user);
  await redis(env, "SADD", "uids", String(chatId));
}

const isWhitelisted = async (env, chatId) =>
  (await redis(env, "SISMEMBER", "whitelist", String(chatId))) === 1;

/** The user's pending previews map ({firstMessageId: {source, text, media,
 *  caption}}), written by the pipeline right after it sends a digest. */
const loadPending = async (env, chatId) =>
  (await getJson(env, `state:${chatId}`))?.pending ?? null;

/** Log a ✅/❌ verdict so the ranking model learns the owner's taste. */
async function recordFeedback(env, chatId, idsStr, verdict) {
  if (!idsStr) return; // previews sent by older versions carry no ids on Skip
  const firstId = idsStr.split(",")[0];
  try {
    const entry = (await loadPending(env, chatId))?.[firstId];
    if (!entry) return;
    const key = `feedback:${chatId}`;
    await redis(env, "RPUSH", key,
      JSON.stringify({ verdict, source: entry.source, text: entry.text }));
    await redis(env, "LTRIM", key, -30, -1);
  } catch (err) {
    console.log("feedback record failed:", err);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read-modify-write the user's pending previews in state:<id>. The callback
 *  gets the pending map; return false to abort without saving. */
async function mutatePending(env, chatId, mutate) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const key = `state:${chatId}`;
      const state = (await getJson(env, key)) || {};
      if (!state.pending) return false;
      if (mutate(state.pending) === false) return false;
      await setJson(env, key, state);
      return true;
    } catch (err) {
      console.log("state save attempt failed:", err);
    }
    await sleep(300);
  }
  return false;
}

/** Set (or clear, with null) the user's pending-✏️-edit marker. */
async function setEditing(env, chatId, value) {
  try {
    const user = await loadUser(env, chatId);
    if (!user) return false;
    if (value) user.editing = value;
    else delete user.editing;
    await saveUser(env, chatId, user);
    return true;
  } catch (err) {
    console.log("editing flag save failed:", err);
    return false;
  }
}

/* ---------------- GitHub (workflow dispatch only) ---------------- */

function ghHeaders(env) {
  return {
    authorization: `Bearer ${env.GH_TOKEN}`,
    accept: "application/vnd.github+json",
    "user-agent": "xdigest-worker",
  };
}

/* ---------------- Commands ---------------- */

function userDefaults() {
  return { channel: null, sources: [], hours: [9], timezone: null,
           limit: 3, interests: null, style: null, language: "en" };
}

async function handleMessage(msg, env, ctx) {
  if (msg.chat.type !== "private") return;
  const chatId = msg.chat.id;

  // Forwarded from a private channel → capture its numeric id as the target.
  const fwd = msg.forward_origin;
  if (fwd?.type === "channel") {
    await setField(env, chatId, (u) => { u.channel = fwd.chat.id; },
      `📢 Channel set to "${esc(fwd.chat.title)}". ` +
      `Make sure I'm an admin there with "Post messages" permission.`);
    return;
  }

  // Payment confirmation arrives as a service message, not a command.
  if (msg.successful_payment) {
    const sp = msg.successful_payment;
    const until = sp.subscription_expiration_date
      ? new Date(sp.subscription_expiration_date * 1000)
      : new Date(Date.now() + 31 * 86400 * 1000);
    await setField(env, chatId, (u) => { u.paid_until = until.toISOString(); },
      `⭐ Pro is active until ${until.toISOString().slice(0, 10)}. ` +
      `It renews automatically — manage or cancel anytime in ` +
      `Telegram Settings → My Stars.`);
    // Tell the owner about the sale.
    if (env.ADMIN_ID && String(chatId) !== String(env.ADMIN_ID)) {
      const who = msg.from.username
        ? `@${esc(msg.from.username)}` : esc(msg.from.first_name || "someone");
      await reply(env, Number(env.ADMIN_ID),
        `💰 ${who} (id ${chatId}) paid ${sp.total_amount} Stars — ` +
        `Pro until ${until.toISOString().slice(0, 10)}` +
        (sp.is_recurring ? " (recurring)" : ""));
    }
    return;
  }

  // A pending ✏️ Edit captures the next regular message as the new post
  // content: text replaces the caption, attached photos replace all media.
  const commandish =
    !!msg.text && (MENU_BUTTONS[msg.text.trim()] || msg.text.trim()).startsWith("/");
  if (!commandish && (msg.text || msg.caption || msg.photo || msg.video)) {
    let editing = null;
    try {
      editing = (await loadUser(env, chatId))?.editing;
    } catch (err) {
      console.log("config load failed:", err);
    }
    if (editing && editing.until > Date.now()) {
      return handleEditContent(msg, editing, env, ctx);
    }
  }

  if (!msg.text) return;
  const text = MENU_BUTTONS[msg.text.trim()] || msg.text.trim();
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const arg = rest.join(" ").trim();
  const isAdmin = isAdminUser(msg.from, env);

  switch (cmd) {
    case "/start":
    case "/help": {
      await reply(env, chatId, HELP + (isAdmin ? ADMIN_HELP : ""),
        { reply_markup: MENU });
      if (cmd === "/start" && !isAdmin && await maybeGrantPromo(env, chatId)) {
        await reply(env, chatId,
          "🎁 You're one of our first users — Pro is free for your first month! " +
          "6 digest times a day, 25 accounts. Tell us what to improve: /feedback");
        if (env.ADMIN_ID) {
          await reply(env, Number(env.ADMIN_ID),
            `🎁 Promo slot used by id ${chatId}` +
            (msg.from.username ? ` (@${esc(msg.from.username)})` : ""));
        }
      }
      return;
    }

    case "/feedback": {
      if (!arg) {
        return reply(env, chatId,
          "Usage: /feedback your message — goes straight to the maker");
      }
      if (env.ADMIN_ID) {
        const who = msg.from.username
          ? `@${esc(msg.from.username)}` : esc(msg.from.first_name || "user");
        await reply(env, Number(env.ADMIN_ID),
          `📮 Feedback from ${who} (id ${chatId}):\n${esc(arg)}`);
      }
      return reply(env, chatId, "📮 Thanks! Passed straight to the maker.");
    }

    case "/id":
      return reply(env, chatId, `Your id: ${msg.from.id}`);

    case "/pro":
    case "/upgrade": {
      const u = await loadUser(env, chatId);
      if (isAdmin || (await isWhitelisted(env, chatId))) {
        return reply(env, chatId, "You already have Pro (courtesy of the house 🎩)");
      }
      if (hasPaidPro(u)) {
        return reply(env, chatId,
          `You're already Pro until ${u.paid_until.slice(0, 10)} ⭐`);
      }
      const price = Number(env.PRO_PRICE_STARS || 550);
      // Subscription invoices can only be created as links (sendInvoice with
      // subscription_period fails with SUBSCRIPTION_EXPORT_MISSING).
      const res = await tg(env, "createInvoiceLink", {
        title: "XGist Pro",
        description:
          "Up to 6 digest times per day and 25 watched accounts. " +
          "Renews monthly, cancel anytime in Telegram settings.",
        payload: "pro-sub",
        currency: "XTR",
        prices: [{ label: "XGist Pro, 30 days", amount: price }],
        subscription_period: 2592000,
      });
      if (!res.ok) {
        return reply(env, chatId,
          `Couldn't create the invoice: ${esc(res.description || "unknown error")}`);
      }
      return reply(env, chatId,
        `⭐ <b>XGist Pro</b> — ${price} Stars / month\n` +
        `6 digest times a day · 25 watched accounts\n` +
        `Renews automatically; cancel anytime in Telegram Settings → My Stars.`,
        { reply_markup: { inline_keyboard: [[
          { text: `⭐ Subscribe — ${price} Stars/mo`, url: res.result },
        ]] } });
    }

    case "/channel": {
      if (!/^@[a-zA-Z0-9_]{4,}$/.test(arg) && !/^-100\d+$/.test(arg)) {
        return reply(env, chatId,
          "Usage: /channel @yourchannel\n(or forward me a message from a private channel)");
      }
      const value = arg.startsWith("@") ? arg : Number(arg);
      const u0 = await loadUser(env, chatId);
      return setField(env, chatId, (u) => { u.channel = value; },
        `📢 Channel set to ${esc(arg)}. Make sure I'm an admin there with "Post messages" permission.` +
        setupHints({ channel: value, sources: u0?.sources }));
    }

    case "/add": {
      const handles = arg.split(/[,\s@]+/).map((h) => h.toLowerCase())
        .filter((h) => /^[a-z0-9_]{1,15}$/.test(h));
      if (!handles.length) return reply(env, chatId, "Usage: /add @naval @pmarca");
      const u0 = await loadUser(env, chatId);
      const max = (await limitsFor(env, chatId, u0, isAdmin)).sources;
      const current = u0?.sources || [];
      const merged = [...new Set([...current, ...handles])];
      if (merged.length > max) {
        return reply(env, chatId,
          `Your plan includes up to ${max} accounts (you'd have ${merged.length}). ` +
          `Pro gives you ${LIMITS.pro.sources} — /pro`);
      }
      return setField(env, chatId, (u) => {
        u.sources = [...new Set([...u.sources, ...handles])].slice(0, max);
      }, `👀 Now watching: ${handles.map(xlink).join(", ")}` +
         setupHints({ channel: u0?.channel, sources: merged }));
    }

    case "/remove": {
      const handle = arg.replace(/^@/, "").toLowerCase();
      return setField(env, chatId, (u) => {
        u.sources = u.sources.filter((s) => s !== handle);
      }, `🗑 Removed <code>@${esc(handle)}</code>`);
    }

    case "/list": {
      const u = await loadUser(env, chatId);
      return reply(env, chatId,
        u?.sources?.length
          ? "👀 You're watching:\n" + u.sources.map(xlink).join("\n")
          : "You're not watching anyone yet — try /add @naval");
    }

    case "/times":
    case "/schedule": {
      const hours = [...new Set(arg.split(/[,\s]+/).map(Number)
        .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b);
      if (!hours.length) {
        return reply(env, chatId,
          "Usage: /schedule 9,18 — the hours (0-23) when you want your digest, in your timezone");
      }
      const u0 = await loadUser(env, chatId);
      const max = (await limitsFor(env, chatId, u0, isAdmin)).hours;
      if (hours.length > max) {
        return reply(env, chatId,
          `Your plan includes up to ${max} digest time(s) per day. ` +
          `Pro gives you ${LIMITS.pro.hours} — /pro`);
      }
      return setField(env, chatId, (u) => { u.hours = hours; },
        `🕘 Digest schedule: ${hours.map((h) => String(h).padStart(2, "0") + ":00").join(", ")} (your timezone)` +
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
        `🌐 Posts will be written in ${names[lang]}.`);
    }

    // Hidden power-user command (not in /help): steers what "interesting" means.
    case "/interests":
      return setField(env, chatId, (u) => { u.interests = arg || null; },
        arg ? "Interests saved." : "Interests cleared.");

    case "/style":
    case "/post_style":
      return setField(env, chatId, (u) => { u.style = arg || null; },
        arg ? "✍️ Caption style saved." : "✍️ Caption style reset to default.");

    case "/settings": {
      const u = (await loadUser(env, chatId)) || userDefaults();
      const paid = hasPaidPro(u);
      const pro = isAdmin || paid || (await isWhitelisted(env, chatId));
      const langNames = { en: "English", uk: "Ukrainian", ru: "Russian" };
      const lines = [
        "⚙️ <b>Your setup</b>",
        "",
        `📢 Channel: ${u.channel ? esc(String(u.channel)) : "not set — /channel @yourchannel"}`,
        `👀 Watching: ${u.sources?.length ? u.sources.map(xlink).join(", ") : "nobody — /add @naval"}`,
        `🕘 Schedule: ${(u.hours || []).map((h) => String(h).padStart(2, "0") + ":00").join(", ")}`,
        `🌍 Timezone: ${u.timezone ? esc(u.timezone) : "Europe/Kyiv (default)"}`,
        `🌐 Language: ${langNames[u.language || "en"]}`,
        `✍️ Style: ${u.style ? esc(u.style) : "default"}`,
        `🔢 Posts per digest: ${u.limit}`,
        pro
          ? (paid ? `⭐ Plan: Pro until ${u.paid_until.slice(0, 10)}` : "⭐ Plan: Pro")
          : "🆓 Plan: free — upgrade with /pro",
      ];
      return reply(env, chatId, lines.join("\n"));
    }

    case "/whitelist":
    case "/unwhitelist": {
      if (!isAdmin) return reply(env, chatId, "Unknown command. /help");
      if (!/^\d+$/.test(arg)) {
        return reply(env, chatId,
          `Usage: ${cmd} 123456789\n(the user can get their numeric id with /id)`);
      }
      const adding = cmd === "/whitelist";
      try {
        await redis(env, adding ? "SADD" : "SREM", "whitelist", arg);
      } catch (err) {
        console.log("whitelist update failed:", err);
        return reply(env, chatId, "Storage hiccup, please try again.");
      }
      return reply(env, chatId, adding
        ? `Whitelisted ${arg} — they now have pro limits.`
        : `Removed ${arg} from the whitelist.`);
    }

    case "/whitelisted": {
      if (!isAdmin) return reply(env, chatId, "Unknown command. /help");
      const list = ((await redis(env, "SMEMBERS", "whitelist")) || []).sort();
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
      const ids = ((await redis(env, "SMEMBERS", "uids")) || []).sort();
      if (!ids.length) return reply(env, chatId, "No users yet.");
      const raws = await redis(env, "MGET", ...ids.map((id) => `user:${id}`));
      const wl = new Set((await redis(env, "SMEMBERS", "whitelist")) || []);
      const lines = ids.flatMap((id, i) => {
        if (!raws[i]) return [];
        const u = JSON.parse(raws[i]);
        const plan = hasPaidPro(u)
          ? `⭐ paid until ${u.paid_until.slice(0, 10)}`
          : wl.has(id) ? "⭐ whitelisted" : "🆓 free";
        return `${id} → ${esc(String(u.channel || "no channel"))}, ` +
               `${(u.sources || []).length} sources, ${(u.hours || []).length} time(s)/day · ${plan}`;
      });
      return reply(env, chatId, lines.length ? lines.join("\n") : "No users yet.");
    }

    default:
      return reply(env, chatId, "Unknown command. /help");
  }
}

async function setField(env, chatId, mutate, confirmation) {
  try {
    const user = (await loadUser(env, chatId)) || userDefaults();
    mutate(user);
    await saveUser(env, chatId, user);
    return reply(env, chatId, confirmation);
  } catch (err) {
    console.log("config save failed:", err);
    return reply(env, chatId, "Storage hiccup, please try again.");
  }
}

/* ---------------- One-click publish ---------------- */

/** The preview's control buttons. Mirrored in pipeline/tg.py send_controls —
 *  keep the two in sync. */
function controlKeyboard(idsStr, spoilerOn = false) {
  return { inline_keyboard: [
    [{ text: "✅ Post", callback_data: `p:${idsStr}` },
     { text: "🕐 Schedule", callback_data: `sc:${idsStr}` }],
    [{ text: "❌ Skip", callback_data: `s:${idsStr}` },
     { text: "✏️ Edit", callback_data: `e:${idsStr}` }],
    [{ text: spoilerOn ? "🫥 Remove spoiler" : "🫥 Spoiler",
       callback_data: `${spoilerOn ? "sp0" : "sp1"}:${idsStr}` }],
  ] };
}

/** Current hour (0-23) in an IANA timezone. */
const hourIn = (tz) => Number(new Intl.DateTimeFormat("en-GB", {
  timeZone: tz, hour: "2-digit", hourCycle: "h23",
}).format(new Date()));

const DEFAULT_TZ = "Europe/Kyiv";

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const controlId = cb.message.message_id;
  const answer = (text, alert = false) =>
    tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert });

  // 🫥 toggle: re-edit the preview so media (and text) are spoiler-blurred;
  // copyMessages then carries the blur into the channel on ✅.
  if (cb.data.startsWith("sp1:") || cb.data.startsWith("sp0:")) {
    const on = cb.data[2] === "1";
    const idsStr = cb.data.slice(4);
    const firstId = idsStr.split(",")[0];
    let entry = null;
    try {
      entry = (await loadPending(env, chatId))?.[firstId];
    } catch (err) {
      console.log("state load failed:", err);
    }
    if (!entry || (!entry.media?.length && !entry.caption)) {
      // Either a pre-spoiler-era preview, or the digest run hasn't saved
      // this user's state yet (it lands seconds after the previews).
      return answer("Preview data isn't synced yet — try again in a moment.", true);
    }
    const veiled = (t) => `<tg-spoiler>${esc(t)}</tg-spoiler>`;
    if (entry.media?.length) {
      for (let i = 0; i < entry.media.length; i++) {
        const m = entry.media[i];
        const im = { type: m.type, media: m.file_id, has_spoiler: on };
        if (i === 0 && entry.caption) {
          im.caption = on ? veiled(entry.caption) : entry.caption;
          if (on) im.parse_mode = "HTML";
        }
        await tg(env, "editMessageMedia",
          { chat_id: chatId, message_id: m.id, media: im });
      }
    } else {
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: Number(firstId),
        text: on ? veiled(entry.caption) : entry.caption,
        ...(on ? { parse_mode: "HTML" } : {}),
      });
    }
    await tg(env, "editMessageReplyMarkup", {
      chat_id: chatId, message_id: controlId,
      reply_markup: controlKeyboard(idsStr, on),
    });
    return answer(on ? "Spoiler on — it stays when you publish" : "Spoiler off");
  }

  // ✏️ edit: arm the user's "editing" marker — their next regular message
  // becomes the new post content (see handleEditContent).
  if (cb.data.startsWith("e:")) {
    const ids = cb.data.slice(2).split(",").map(Number);
    let entry = null;
    try {
      entry = (await loadPending(env, chatId))?.[String(ids[0])];
    } catch (err) {
      console.log("state load failed:", err);
    }
    if (!entry) {
      return answer("Preview data isn't synced yet — try again in a moment.", true);
    }
    const prompt = [];
    if (entry.caption) {
      const res = await tg(env, "sendMessage", {
        chat_id: chatId, text: entry.caption, parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      if (res.ok) prompt.push(res.result.message_id);
    }
    const instr = await reply(env, chatId,
      "✏️ Send me the new version as a regular message.\n\n" +
      "• text — replaces the caption (current text is above, long-press to copy)\n" +
      "• photos/video — replace ALL current media (add text to change both)\n" +
      "• \"-\" — removes the caption",
      { reply_markup: { inline_keyboard: [[
        { text: "✖️ Cancel", callback_data: "ec" },
      ]] } });
    if (instr.ok) prompt.push(instr.result.message_id);
    const ok = await setEditing(env, chatId, {
      ids, control: controlId, prompt, until: Date.now() + 10 * 60 * 1000,
    });
    if (!ok) return answer("Storage hiccup — tap ✏️ Edit again.", true);
    return answer("");
  }

  if (cb.data === "ec") {
    try {
      const editing = (await loadUser(env, chatId))?.editing;
      for (const id of editing?.prompt || []) {
        await tg(env, "deleteMessage", { chat_id: chatId, message_id: id });
      }
    } catch (err) {
      console.log("edit cancel cleanup failed:", err);
    }
    await setEditing(env, chatId, null);
    return answer("Edit cancelled");
  }

  // 🕐 schedule: swap the control buttons for an hour grid; the pick is
  // stored in the "sched" hash and published by the hourly cron (the digest
  // cron already fires at :00 every hour, so only whole hours make sense).
  if (cb.data.startsWith("sc:")) {
    const idsStr = cb.data.slice(3);
    const rows = [];
    for (let h = 0; h < 24; h += 6) {
      rows.push(Array.from({ length: 6 }, (_, i) => ({
        text: String(h + i).padStart(2, "0"),
        callback_data: `sh${h + i}:${idsStr}`,
      })));
    }
    rows.push([{ text: "⬅️ Back", callback_data: `sb:${idsStr}` }]);
    await tg(env, "editMessageReplyMarkup", {
      chat_id: chatId, message_id: controlId,
      reply_markup: { inline_keyboard: rows },
    });
    return answer("Pick the hour to publish (your timezone)");
  }

  if (cb.data.startsWith("sb:")) {
    await tg(env, "editMessageReplyMarkup", {
      chat_id: chatId, message_id: controlId,
      reply_markup: controlKeyboard(cb.data.slice(3)),
    });
    return answer("");
  }

  if (/^sh\d+:/.test(cb.data)) {
    const [head, idsStr] = cb.data.split(":");
    const hour = Number(head.slice(2));
    const user = await loadUser(env, chatId);
    if (!user?.channel) return answer("Set your channel first: /channel @name", true);
    const tz = user.timezone || DEFAULT_TZ;
    try {
      await redis(env, "HSET", "sched", `${chatId}:${controlId}`, JSON.stringify({
        chat: chatId, control: controlId, ids: idsStr, hour, tz,
      }));
    } catch (err) {
      console.log("schedule save failed:", err);
      return answer("Storage hiccup — try again.", true);
    }
    const label = `${String(hour).padStart(2, "0")}:00`;
    await tg(env, "editMessageReplyMarkup", {
      chat_id: chatId, message_id: controlId,
      reply_markup: { inline_keyboard: [[
        { text: `🕐 Scheduled for ${label} — tap to cancel`,
          callback_data: `su:${idsStr}` },
      ]] },
    });
    return answer(`Will publish at the next ${label} (${tz})`);
  }

  if (cb.data.startsWith("su:")) {
    try {
      await redis(env, "HDEL", "sched", `${chatId}:${controlId}`);
    } catch (err) {
      console.log("schedule cancel failed:", err);
      return answer("Storage hiccup — try again.", true);
    }
    await tg(env, "editMessageReplyMarkup", {
      chat_id: chatId, message_id: controlId,
      reply_markup: controlKeyboard(cb.data.slice(3)),
    });
    return answer("Schedule cancelled");
  }

  if (cb.data === "s" || cb.data.startsWith("s:")) {
    await tg(env, "editMessageText",
      { chat_id: chatId, message_id: controlId, text: "❌ Skipped" });
    await recordFeedback(env, chatId, cb.data.slice(2), "skipped");
    return answer("Skipped");
  }

  if (cb.data.startsWith("p:")) {
    const ids = cb.data.slice(2).split(",").map(Number).sort((a, b) => a - b);
    const user = await loadUser(env, chatId);
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
    const dest = typeof user.channel === "string" ? user.channel : "your channel";
    await tg(env, "editMessageText",
      { chat_id: chatId, message_id: controlId, text: `✅ Posted to ${dest}` });
    await recordFeedback(env, chatId, cb.data.slice(2), "approved");
    return answer("Posted!");
  }

  return answer("");
}

/* ---------------- 🕐 Scheduled publishing ---------------- */

/** Publish every "sched" entry whose local hour has arrived. Runs from the
 *  hourly cron; entries are dropped after one attempt (success or not) so a
 *  broken one can't retry forever. */
async function publishScheduled(env) {
  let flat;
  try {
    flat = await redis(env, "HGETALL", "sched");
  } catch (err) {
    console.log("sched load failed:", err);
    return;
  }
  if (!flat?.length) return;
  for (let i = 0; i < flat.length; i += 2) {
    const field = flat[i];
    let job;
    try {
      job = JSON.parse(flat[i + 1]);
      if (hourIn(job.tz) !== job.hour) continue;
    } catch (err) {
      console.log(`dropping bad sched entry ${field}:`, err);
      await redis(env, "HDEL", "sched", field);
      continue;
    }
    try {
      const user = await loadUser(env, job.chat);
      const ids = job.ids.split(",").map(Number).sort((a, b) => a - b);
      const result = user?.channel && await tg(env, "copyMessages", {
        chat_id: user.channel, from_chat_id: job.chat, message_ids: ids,
      });
      if (result?.ok) {
        const dest = typeof user.channel === "string" ? user.channel : "your channel";
        await tg(env, "editMessageText", {
          chat_id: job.chat, message_id: job.control,
          text: `✅ Posted to ${dest} (scheduled)`,
        });
        await recordFeedback(env, job.chat, job.ids, "approved");
      } else {
        await tg(env, "editMessageText", {
          chat_id: job.chat, message_id: job.control,
          text: `⚠️ Scheduled post failed: ${result?.description || "no channel set"}. ` +
                "The preview above is untouched — post it manually.",
        });
      }
    } catch (err) {
      console.log(`scheduled publish failed for ${field}:`, err);
    }
    await redis(env, "HDEL", "sched", field);
  }
}

/* ---------------- ✏️ Edit a pending preview ---------------- */

/** Apply the user's edit message to the preview armed by the ✏️ button.
 *  Text-only edits rewrite the caption in place; attached media replace the
 *  whole preview (old messages deleted, new ones sent from the uploaded
 *  file_ids), so ✅ Post later copies exactly what the user sees. */
async function handleEditContent(msg, editing, env, ctx) {
  const chatId = msg.chat.id;
  const firstId = String(editing.ids[0]);
  let entry = null;
  try {
    entry = (await loadPending(env, chatId))?.[firstId];
  } catch (err) {
    console.log("state load failed:", err);
  }
  if (!entry) {
    await setEditing(env, chatId, null);
    return reply(env, chatId, "Can't find that preview anymore — tap ✏️ Edit again.");
  }

  const raw = (msg.text ?? msg.caption ?? "").trim();
  const newCaption = raw === "-" ? "" : raw ? formatCaption(raw) : null; // null → keep current
  const item = msg.photo
    ? { type: "photo", file_id: msg.photo.at(-1).file_id }
    : msg.video ? { type: "video", file_id: msg.video.file_id } : null;
  if (!item && newCaption === null) return; // sticker/voice/etc — not applicable

  if (!item) {
    // Text-only edit: keep the current media (file_ids from state.json) and
    // rebuild the preview with the new caption, same as a media edit.
    if (!newCaption && !entry.media?.length) {
      return reply(env, chatId, "A text-only post can't have empty text.");
    }
    return applyRebuild(env, chatId, editing, entry, firstId,
      entry.media || [], newCaption);
  }

  if (!msg.media_group_id) {
    return applyRebuild(env, chatId, editing, entry, firstId, [item],
      newCaption ?? entry.caption);
  }

  // Album: Telegram delivers each photo as a separate update. Stage them in
  // the pending entry; after a pause, the update holding the highest
  // message_id rebuilds the preview with everything collected.
  const group = msg.media_group_id;
  await mutatePending(env, chatId, (pending) => {
    const e = pending[firstId];
    if (!e) return false;
    if (e.staged?.group !== group) e.staged = { group, items: [], text: null };
    e.staged.items.push({ ...item, mid: msg.message_id });
    if (newCaption !== null) e.staged.text = newCaption;
  });
  const work = (async () => {
    await sleep(3000);
    const e = (await loadPending(env, chatId))?.[firstId];
    const staged = e?.staged;
    if (!staged || staged.group !== group) return;
    if (Math.max(...staged.items.map((i) => i.mid)) !== msg.message_id) return;
    const items = [...staged.items].sort((a, b) => a.mid - b.mid).slice(0, 10);
    await applyRebuild(env, chatId, editing, e, firstId, items,
      staged.text ?? e.caption);
  })().catch((err) => console.log("album edit failed:", err));
  if (ctx) ctx.waitUntil(work);
  else await work;
}

/** Replace the preview wholesale: delete the old messages, resend media from
 *  the user's uploaded file_ids, issue fresh control buttons, and re-key the
 *  pending entry so ✅/❌/🫥/✏️ keep working on the new message ids. */
async function applyRebuild(env, chatId, editing, entry, firstId, items, captionHtml) {
  const caption = (captionHtml || "").slice(0, items.length ? 1024 : 4096);
  let msgs;
  if (!items.length) {
    const res = await tg(env, "sendMessage", {
      chat_id: chatId, text: caption, parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    if (!res.ok) return reply(env, chatId, "Couldn't rebuild the preview — try again.");
    msgs = [res.result];
  } else if (items.length === 1) {
    const { type, file_id } = items[0];
    const res = await tg(env, type === "photo" ? "sendPhoto" : "sendVideo", {
      chat_id: chatId, [type]: file_id,
      ...(caption ? { caption, parse_mode: "HTML" } : {}),
    });
    if (!res.ok) return reply(env, chatId, "Couldn't rebuild the preview — try again.");
    msgs = [res.result];
  } else {
    const res = await tg(env, "sendMediaGroup", {
      chat_id: chatId,
      media: items.map((it, i) => ({
        type: it.type, media: it.file_id,
        ...(i === 0 && caption ? { caption, parse_mode: "HTML" } : {}),
      })),
    });
    if (!res.ok) return reply(env, chatId, "Couldn't rebuild the preview — try again.");
    msgs = res.result;
  }
  for (const id of [...editing.ids, editing.control]) {
    await tg(env, "deleteMessage", { chat_id: chatId, message_id: id });
  }
  const ids = msgs.map((m) => m.message_id);
  const refs = msgs.filter((m) => m.photo || m.video).map((m) => m.photo
    ? { id: m.message_id, type: "photo", file_id: m.photo.at(-1).file_id }
    : { id: m.message_id, type: "video", file_id: m.video.file_id });
  const idsStr = ids.join(",");
  let channel = null;
  try {
    channel = (await loadUser(env, chatId))?.channel;
  } catch (err) {
    console.log("config load failed:", err);
  }
  const dest = typeof channel === "string" ? esc(channel) : "your channel";
  await reply(env, chatId,
    `✏️ edited · <a href="https://x.com/${entry.source}">@${esc(entry.source)}</a>` +
    `\nPublish to ${dest}?`,
    { reply_markup: controlKeyboard(idsStr) });
  await mutatePending(env, chatId, (pending) => {
    delete pending[firstId];
    pending[String(ids[0])] = {
      source: entry.source, text: entry.text, media: refs, caption,
    };
  });
  await finishEdit(env, chatId, editing);
}

/** Clean up the ✏️ prompt messages and disarm the editing marker. */
async function finishEdit(env, chatId, editing) {
  for (const id of editing.prompt || []) {
    await tg(env, "deleteMessage", { chat_id: chatId, message_id: id });
  }
  await setEditing(env, chatId, null);
}

/* ---------------- Landing page (GET requests) ---------------- */

async function serveSite(request, env) {
  const url = new URL(request.url);
  const origin = url.origin;

  // One-time setup: registers the "/" command autocomplete with Telegram.
  if (url.pathname === "/setup-commands") {
    if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    const results = await setupCommands(env);
    return new Response(JSON.stringify(results, null, 2),
      { headers: { "content-type": "application/json" } });
  }

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
  const title = "XGist — the best of X (Twitter), distilled to your Telegram channel";
  const description =
    "Telegram bot that watches X (Twitter) accounts, extracts the posts worth reading " +
    "with AI, and publishes them to your channel in one tap. Save 30+ hours a month.";

  const faq = [
    ["How does XGist post to my channel?",
     "You add the bot as an administrator of your channel with the single " +
     "permission to post messages. Nothing else is required — no passwords, no API keys."],
    ["Do I need a server or any technical setup?",
     "No. You send the bot a list of X accounts and the hours you want digests. Everything else is automatic."],
    ["How does it choose which posts to surface?",
     "It shortlists new posts by engagement, then an AI model ranks them against " +
     "your taste — learned from every ✅ and ❌ you tap — and writes a caption in your language. You approve every post before it goes out."],
    ["Is it free?",
     "The core is free. First 100 users get a full Pro month automatically — no card needed. " +
     "Pro unlocks more watched accounts and more digest times per day."],
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: "XGist",
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
  <h1>The <em>gist</em> of X (Twitter) — delivered to your Telegram channel</h1>
  <p class="lead">XGist watches the X accounts you choose, distills the posts
  worth reading with AI, and sends you digests at the hours you set.
  One tap — published to your channel, media and caption included.
  Save 30+ hours a month.</p>
  <a class="cta" href="${botLink}">Open XGist in Telegram →</a>
  <p class="hint">First 100 users get Pro free for a month — no card needed.</p>

  <h2>How it works</h2>
  <ol class="steps">
    <li>Tell the bot which X accounts to watch: <code>/add naval pmarca</code></li>
    <li>Set your digest hours: <code>/schedule 9,18</code></li>
    <li>Add the bot as admin of your channel</li>
    <li>Get digests, tap ✅ — the post is in your channel in a second</li>
  </ol>

  <h2>Seen in the wild</h2>
  <p style="color:var(--muted);margin-bottom:8px">
    <a href="https://t.me/aidistilled" target="_blank" rel="noopener">@aidistilled</a>
    — daily AI news from X, curated and posted entirely with XGist.
  </p>

  <h2>Why channel admins use it</h2>
  <ul class="features">
    <li>AI curation — ranks posts by engagement <em>and</em> your taste, learned from every ✅ and ❌</li>
    <li>Captions written in your channel's language and style</li>
    <li>You approve everything — nothing is ever posted without your tap</li>
    <li>Photos and videos come through natively, not as screenshots</li>
    <li>No passwords, no API keys, no server — a two-minute setup</li>
  </ul>

  <h2>Questions</h2>
  ${faqHTML}

  <footer>XGist · <a href="${botLink}">@${botUser || "the bot"}</a> ·
  posts only what you approve</footer>
</main>
</body>
</html>`;
}
