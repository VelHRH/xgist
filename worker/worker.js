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
 *   PRO_PRICE_STARS — monthly Pro price in Telegram Stars (default 550)
 *
 * GET requests serve the landing page (plus /robots.txt and /sitemap.xml);
 * POST requests are the Telegram webhook.
 */

// Free vs pro limits. Whitelisted users (and the admin) get pro; later,
// paying users plug into the same check.
const LIMITS = {
  free: { sources: 5, hours: 1, thread_posts: 1 },
  pro: { sources: 25, hours: 6, thread_posts: 5 },
};

// A tweet permalink anywhere in a DM triggers a thread post. Tolerates
// www./mobile./m. subdomains, x.com or twitter.com, and any query/fragment
// suffix; captures the whole URL (the pipeline re-parses the numeric id).
const TWEET_URL_RE =
  /(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:twitter|x)\.com\/[^/\s]+\/status\/\d+/i;

function firstTweetUrl(text) {
  const m = String(text || "").match(TWEET_URL_RE);
  return m ? m[0] : null;
}

function isAdminUser(from, env) {
  return !!(from && env.ADMIN_ID && String(from.id) === String(env.ADMIN_ID));
}

function effectivePlan(user, { isAdmin = false, whitelisted = false,
                               promotional = false } = {}) {
  const usage = {
    sources: (user?.sources || []).length,
    hours: (user?.hours || []).length,
  };
  if (isAdmin) {
    return { tier: "pro", source: "administrator", expiresAt: null,
             limits: LIMITS.pro, usage };
  }
  const expiresAt = user?.paid_until || null;
  const active = !!(expiresAt && Date.parse(expiresAt) > Date.now());
  if (active && user?.pro_source === "paid") {
    return { tier: "pro", source: "paid", expiresAt,
             limits: LIMITS.pro, usage };
  }
  if (whitelisted) {
    return { tier: "pro", source: "courtesy", expiresAt: null,
             limits: LIMITS.pro, usage };
  }
  if (active) {
    const trial = user?.pro_source === "trial" || (!user?.pro_source && promotional);
    return { tier: "pro", source: trial ? "trial" : "paid", expiresAt,
             limits: LIMITS.pro, usage };
  }
  return { tier: "free", source: "free", expiresAt: null,
           limits: LIMITS.free, usage };
}

async function resolvePlan(env, chatId, user) {
  let plan;
  if (env.ADMIN_ID && String(chatId) === String(env.ADMIN_ID)) {
    plan = effectivePlan(user, { isAdmin: true });
  } else {
    const [whitelisted, promotional] = await Promise.all([
      isWhitelisted(env, chatId),
      redis(env, "SISMEMBER", "promo", String(chatId)).then((value) => value === 1),
    ]);
    plan = effectivePlan(user, { whitelisted, promotional });
  }
  if (plan.tier === "pro" && user && !user.pro_access_seen_at) {
    user.pro_access_seen_at = new Date(Date.now()).toISOString();
    await saveUser(env, chatId, user);
  }
  return plan;
}

function planPresentation(plan) {
  if (plan.source === "paid") {
    return {
      label: "⭐ <b>XGist Pro</b>",
      details: `Active until <b>${plan.expiresAt.slice(0, 10)}</b>. ` +
        "Manage renewal in Telegram Settings → My Stars.",
    };
  }
  if (plan.source === "trial") {
    const days = Math.max(1,
      Math.ceil((Date.parse(plan.expiresAt) - Date.now()) / 86400000));
    return {
      label: `⭐ <b>XGist Pro Trial · ${days} day${days === 1 ? "" : "s"} left</b>`,
      details: `Full Pro access is active until <b>${plan.expiresAt.slice(0, 10)}</b>.`,
    };
  }
  if (plan.source === "courtesy") {
    return {
      label: "⭐ <b>XGist Pro · Courtesy access</b>",
      details: "Full Pro access, courtesy of XGist.",
    };
  }
  if (plan.source === "administrator") {
    return {
      label: "⭐ <b>XGist Pro · Administrator</b>",
      details: "Full Pro access for the XGist administrator.",
    };
  }
  return {
    label: "🆓 <b>XGist Free</b>",
    details: "Upgrade with /pro",
  };
}

function planWelcome(plan) {
  const capacity = plan.tier === "pro"
    ? `${plan.limits.sources} watched accounts · ${plan.limits.hours} Digest times/day`
    : `${plan.limits.sources} watched accounts · ${plan.limits.hours} Digest time/day`;
  return `${planPresentation(plan).label}\n${capacity}`;
}

// Early-access gift: the first PROMO_SLOTS users to /start get a free month
// of Pro. Grant ids are tracked in the "promo" Redis set so slots are never
// reused (SADD returning 0 means this id already claimed one).
const PROMO_SLOTS = 50;

async function maybeGrantPromo(env, chatId) {
  const id = String(chatId);
  try {
    const user = await loadUser(env, chatId);
    if ((await resolvePlan(env, chatId, user)).tier === "pro") return false;
    if ((await redis(env, "SCARD", "promo")) >= PROMO_SLOTS) return false;
    if ((await redis(env, "SADD", "promo", id)) !== 1) return false;
    const entry = user || userDefaults();
    entry.paid_until = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    entry.pro_source = "trial";
    delete entry.free_since;
    delete entry.pro_invite_sent_at;
    await saveUser(env, chatId, entry);
    return true;
  } catch (err) {
    console.log("promo grant failed:", err);
    return false;
  }
}

async function registerFreeUser(env, chatId, plan) {
  const user = (await loadUser(env, chatId)) || userDefaults();
  if (plan.tier === "free" && !user.free_since) {
    user.free_since = new Date().toISOString();
  }
  await saveUser(env, chatId, user);
}

async function limitsFor(env, chatId, user) {
  return (await resolvePlan(env, chatId, user)).limits;
}

/** Warn about missing setup steps — digests silently skip incomplete users. */
function setupHints({ sources }) {
  const missing = [];
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
      if (update.account_validation) {
        await handleAccountValidation(update.account_validation, env);
      } else if (update.pre_checkout_query) {
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
      dispatchDigest(env, {}).then(async (resp) => {
        if (resp.status !== 204) {
          console.log("cron dispatch failed:", resp.status, await resp.text());
        }
      }),
      publishScheduled(env)
        .then(() => sendProInvites(env))
        .then(() => sendSetupReminders(env)),
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
  ],
  resize_keyboard: true,
  is_persistent: true,
};
const MENU_BUTTONS = {
  "⚙️ Settings": "/settings",
  "📋 My accounts": "/list",
};

// Registered in Telegram's "/" autocomplete via GET /setup-commands?key=<WEBHOOK_SECRET>
const COMMANDS = [
  ["start", "open your home or resume setup"],
  ["channel", "manage your Publishing channel"],
  ["add", "add a Watched account"],
  ["schedule", "choose your Digest times"],
  ["lang", "choose the post language"],
  ["post_style", "choose how captions are written"],
  ["list", "accounts you watch"],
  ["remove", "remove Watched accounts"],
  ["limit", "choose posts per Digest"],
  ["timezone", "choose your timezone"],
  ["settings", "review and edit your settings"],
  ["pro", "upgrade to Pro ⭐"],
  ["feedback", "message the maker"],
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
 *   user:<id>     — JSON user config (channel, sources, hours, editing, paused, …)
 *                   paused: bool — when set, the digest skips this user (no fetch)
 *   uids          — set of registered user ids
 *   whitelist     — set of ids with free Pro
 *   promo         — set of ids that claimed the early-access month
 *   state:<id>    — JSON per-user pipeline state (pending previews, last run)
 *   feedback:<id> — list of JSON ✅/❌ verdicts, oldest first, trimmed to 30
 *   sched         — hash <chatId>:<controlId> → JSON scheduled-publish job
 *   quota:<id>    — thread-post charges in the rolling 24h window; INCR before
 *                   dispatching a thread fetch, DECR'd by the pipeline on failure
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

/** Kick the digest workflow with the given inputs (cron: {}, one-user digest:
 *  {only_user}, thread post: {thread_url, only_user}). Returns the fetch
 *  Response so each caller can handle status !== 204 its own way. */
function dispatchDigest(env, inputs) {
  return fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/digest.yml/dispatches`,
    {
      method: "POST",
      headers: ghHeaders(env),
      body: JSON.stringify({ ref: "main", inputs }),
    },
  );
}

function normalizeHandle(value) {
  const input = String(value || "").trim();
  const profile = input.match(
    /^(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:twitter|x)\.com\/(@?[a-zA-Z0-9_]{1,15})\/?(?:[?#].*)?$/i,
  );
  const candidate = (profile ? profile[1] : input).replace(/^@/, "");
  return /^[a-zA-Z0-9_]{1,15}$/.test(candidate) ? candidate.toLowerCase() : null;
}

const SETUP_ADD_ACCOUNT = "setup:add-account";
const SETUP_TIMEZONE = "setup:timezone";
const TIMEZONE_CONFIRM = "timezone:confirm";
const TIMEZONE_RETRY = "timezone:retry";
const TIMEZONE_PICK = "timezone:pick:";
const DIGEST_TIME_PICK = "digest-time:pick:";
const DIGEST_TIME_DONE = "digest-time:done";
const SETUP_CONNECT_CHANNEL = "setup:connect-channel";
const SETUP_SKIP_CHANNEL = "setup:skip-channel";
const CHANNEL_RETRY = "channel:retry";
const CHANNEL_PUBLISH = "channel:publish";
const CHANNEL_NOT_NOW = "channel:not-now";
const NAV_SETUP = "nav:setup";
const SETUP_EDIT = "setup:edit:";
const ACCOUNT_ADD = "account:add";
const ACCOUNT_REMOVE_OPEN = "account:remove:open";
const ACCOUNT_REMOVE_PICK = "account:remove:pick:";
const ACCOUNT_REMOVE_DONE = "account:remove:done";
const CHANNEL_CONNECT = "channel:connect";
const CHANNEL_DISCONNECT = "channel:disconnect";
const LANGUAGE_PICK = "language:pick:";
const LIMIT_PICK = "limit:pick:";
const STYLE_CUSTOM = "style:custom";
const STYLE_DEFAULT = "style:default";
const DOWNGRADE_SOURCE = "downgrade:source:";
const DOWNGRADE_HOUR = "downgrade:hour:";
const DOWNGRADE_DONE = "downgrade:done";
const ACCOUNT_REPLACE = "account:replace:";
const ACCOUNT_KEEP = "account:keep:";
const CITY_TIMEZONE_CHOICES = {
  kyiv: [{ label: "Kyiv, Ukraine", zone: "Europe/Kyiv" }],
  kiev: [{ label: "Kyiv, Ukraine", zone: "Europe/Kyiv" }],
  "new york": [{ label: "New York, United States", zone: "America/New_York" }],
  "los angeles": [{ label: "Los Angeles, United States", zone: "America/Los_Angeles" }],
  springfield: [
    { label: "Springfield, Illinois", zone: "America/Chicago" },
    { label: "Springfield, Massachusetts", zone: "America/New_York" },
  ],
};

function setupAccountKeyboard() {
  return { inline_keyboard: [[
    { text: "➕ Add another", callback_data: SETUP_ADD_ACCOUNT },
    { text: "🌍 Choose timezone", callback_data: SETUP_TIMEZONE },
  ]] };
}

function updateSetup(user, { currentStep, addingAccount } = {}) {
  const now = new Date().toISOString();
  const completedAt = !user.setup && user.sources?.length && user.timezone && user.hours?.length
    ? now : null;
  user.setup = {
    started_at: now, completed_at: completedAt, reminder_consumed: false,
    ...user.setup,
  };
  if (user.setup.reminder_attempted_at && !user.setup.reminder_recovered_at) {
    user.setup.reminder_recovered_at = now;
  }
  if (currentStep) user.setup.current_step = currentStep;
  if (addingAccount !== undefined) user.setup.adding_account = addingAccount;
  user.setup.last_activity_at = now;
  return user.setup;
}

function setSetupTimestamp(user, field, value = new Date(Date.now()).toISOString()) {
  if (!user.setup[field]) user.setup[field] = value;
  return user.setup[field];
}

function requiredSetupStep(user) {
  if (!user?.sources?.length) return "account";
  if (!user?.setup?.timezone_confirmed_at) return "timezone";
  if (!user?.setup?.digest_time_confirmed_at) return "digest_time";
  return "complete";
}

function isActivated(user) {
  if (user?.setup?.completed_at) return true;
  return !user?.setup && !!user?.sources?.length && !!user?.timezone && !!user?.hours?.length;
}

function accountStepText(plan) {
  return "<b>Guided setup · Step 1 of 3</b>\n\n" +
    "Tell me one X account worth watching. I’ll use its strongest posts to build " +
    "private Digest previews for you.\n\n" +
    "Send an @handle, bare handle, or X profile URL.\n" +
    `Your ${plan.tier === "pro" ? "Pro" : "Free"} plan includes ` +
    `${plan.limits.sources} watched accounts.`;
}

function canonicalTimezone(input) {
  const value = String(input || "").trim();
  if (!value || /^(?:UTC|GMT|Etc\/(?:UTC|GMT[+-]?\d*))$/i.test(value)) return null;
  try {
    const resolved = new Intl.DateTimeFormat("en", { timeZone: value })
      .resolvedOptions().timeZone;
    if (/^(?:UTC|GMT|Etc\/(?:UTC|GMT[+-]?\d*))$/i.test(resolved)) return null;
    return resolved === "Europe/Kiev" ? "Europe/Kyiv" : resolved;
  } catch {
    return null;
  }
}

function cityTimezoneChoices(input) {
  const city = String(input || "").trim().toLowerCase()
    .replace(/_/g, " ").replace(/\s+/g, " ");
  if (CITY_TIMEZONE_CHOICES[city]) return CITY_TIMEZONE_CHOICES[city];
  const zones = typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("timeZone") : [];
  const matches = zones.filter((zone) =>
    zone.split("/").at(-1).replace(/_/g, " ").toLowerCase() === city);
  return matches.map((zone) => ({ label: zone.replace(/_/g, " "), zone }));
}

function localTimeIn(timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, weekday: "short", day: "2-digit", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(Date.now()));
}

function timezoneConfirmationText(timezone, activated = false) {
  return `<b>${activated ? "Timezone" : "Guided setup · Step 2 of 3"}</b>\n\n` +
    `Timezone: <code>${esc(timezone)}</code>\n` +
    `Current local time: <b>${esc(localTimeIn(timezone))}</b>\n\n` +
    "Is this correct?";
}

function timezoneConfirmationKeyboard() {
  return { inline_keyboard: [
    [{ text: "✅ Confirm timezone", callback_data: TIMEZONE_CONFIRM }],
    [{ text: "Choose another", callback_data: TIMEZONE_RETRY }],
  ] };
}

function selectedDigestTimes(user) {
  return [...new Set(user?.setup?.digest_time_choices || [])]
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)
    .sort((a, b) => a - b);
}

function formatDigestTimes(hours) {
  return (hours || []).map((hour) =>
    `${String(hour).padStart(2, "0")}:00`).join(", ");
}

function planCapacity(plan) {
  return `${plan.limits.sources} Watched accounts · ${plan.limits.hours} Digest time` +
    `${plan.limits.hours === 1 ? "" : "s"}/day`;
}

function selectedFreeValues(configured, selected, limit) {
  const values = [...new Set(configured || [])];
  const required = Math.min(limit, values.length);
  const chosen = [...new Set(selected || [])].filter((value) => values.includes(value));
  return chosen.length === required ? chosen : values.slice(0, limit);
}

function configurationAccess(user, plan) {
  const sources = [...new Set(user.sources || [])];
  const hours = [...new Set(user.hours || [])];
  if (plan.tier === "pro") {
    return { activeSources: sources, inactiveSources: [], activeHours: hours, inactiveHours: [] };
  }
  const activeSources = selectedFreeValues(
    sources, user.free_active_sources, plan.limits.sources);
  const activeHours = selectedFreeValues(hours, user.free_active_hours, plan.limits.hours);
  return {
    activeSources,
    inactiveSources: sources.filter((source) => !activeSources.includes(source)),
    activeHours,
    inactiveHours: hours.filter((hour) => !activeHours.includes(hour)),
  };
}

function ensureFreeSelections(user, plan) {
  const sources = [...new Set(user.sources || [])];
  const hours = [...new Set(user.hours || [])];
  user.free_active_sources = Array.isArray(user.free_active_sources)
    ? [...new Set(user.free_active_sources)].filter((value) => sources.includes(value))
    : selectedFreeValues(sources, null, plan.limits.sources);
  user.free_active_hours = Array.isArray(user.free_active_hours)
    ? [...new Set(user.free_active_hours)].filter((value) => hours.includes(value))
    : selectedFreeValues(hours, null, plan.limits.hours);
  return configurationAccess(user, plan);
}

function configurationLines(user, plan) {
  const access = configurationAccess(user, plan);
  const lines = [
    `👀 Active Watched accounts: ${access.activeSources.length
      ? access.activeSources.map(xlink).join(", ") : "none"}`,
    `🕘 Active Digest times: ${formatDigestTimes(access.activeHours) || "none"}`,
  ];
  if (access.inactiveSources.length || access.inactiveHours.length) {
    lines.push("", "🔒 <b>Inactive Pro configuration</b>");
    if (access.inactiveSources.length) {
      lines.push(`👀 Retained accounts: ${access.inactiveSources.map(xlink).join(", ")}`);
    }
    if (access.inactiveHours.length) {
      lines.push(`🕘 Retained Digest times: ${formatDigestTimes(access.inactiveHours)}`);
    }
    lines.push("Renew Pro access to reactivate everything without re-entry.");
  }
  return lines;
}

function downgradeView(user, plan) {
  const sources = [...new Set(user.sources || [])];
  const hours = [...new Set(user.hours || [])];
  const fallback = configurationAccess(user, plan);
  const selectedSources = Array.isArray(user.free_active_sources)
    ? [...new Set(user.free_active_sources)].filter((source) => sources.includes(source))
    : fallback.activeSources;
  const selectedHours = Array.isArray(user.free_active_hours)
    ? [...new Set(user.free_active_hours)].filter((hour) => hours.includes(hour))
    : fallback.activeHours;
  const inactiveSources = sources.filter((source) => !selectedSources.includes(source));
  const inactiveHours = hours.filter((hour) => !selectedHours.includes(hour));
  const sourceButtons = sources.map((source, index) => ({
    text: `${selectedSources.includes(source) ? "✓ " : ""}@${source}`,
    callback_data: `${DOWNGRADE_SOURCE}${index}`,
  }));
  const hourButtons = hours.map((hour) => ({
    text: `${selectedHours.includes(hour) ? "✓ " : ""}${String(hour).padStart(2, "0")}:00`,
    callback_data: `${DOWNGRADE_HOUR}${hour}`,
  }));
  const keyboard = [];
  for (let index = 0; index < sourceButtons.length; index += 2) {
    keyboard.push(sourceButtons.slice(index, index + 2));
  }
  for (let index = 0; index < hourButtons.length; index += 3) {
    keyboard.push(hourButtons.slice(index, index + 3));
  }
  keyboard.push([{ text: "Done", callback_data: DOWNGRADE_DONE }]);
  return {
    text: "🆓 <b>Pro access ended · your configuration is retained</b>\n\n" +
      `Free keeps ${plan.limits.sources} Watched accounts and ` +
      `${plan.limits.hours} Digest time active. Choose the active items below; ` +
      "everything else stays as Inactive Pro configuration.\n\n" +
      `👀 Selected: ${selectedSources.length}/${Math.min(plan.limits.sources, sources.length)}` +
      `${selectedSources.length ? ` · ${selectedSources.map(xlink).join(", ")}` : ""}\n` +
      `🕘 Selected: ${selectedHours.length}/${Math.min(plan.limits.hours, hours.length)}` +
      `${selectedHours.length ? ` · ${formatDigestTimes(selectedHours)}` : ""}\n\n` +
      "🔒 <b>Inactive Pro configuration</b>\n" +
      `👀 ${inactiveSources.length ? inactiveSources.map(xlink).join(", ") : "none"}\n` +
      `🕘 ${formatDigestTimes(inactiveHours) || "none"}`,
    reply_markup: { inline_keyboard: keyboard },
  };
}

function homeView(user, plan, firstName) {
  const access = configurationAccess(user, plan);
  const hours = formatDigestTimes(access.activeHours);
  const retained = access.inactiveSources.length + access.inactiveHours.length;
  const name = firstName ? `${esc(firstName)}, your` : "Your";
  return {
    text: `🏠 <b>${name} daily briefings</b>\n\n` +
      `🕘 ${access.activeHours.length} active${hours ? ` · ${hours}` : ""}\n` +
      `👀 ${access.activeSources.length} active Watched account` +
      `${access.activeSources.length === 1 ? "" : "s"}\n` +
      (retained ? `🔒 ${access.inactiveSources.length} account(s) and ` +
        `${access.inactiveHours.length} Digest time(s) retained for Pro\n` : "") +
      `🌍 Timezone: ${user.timezone ? esc(user.timezone) : "not set"}\n` +
      `📢 Publishing channel: ${user.channel ? esc(String(user.channel)) : "not connected"}\n\n` +
      planPresentation(plan).label,
    reply_markup: { inline_keyboard: [[
      { text: "⚙️ Settings", callback_data: NAV_SETUP },
    ]] },
  };
}

function digestTimeView(user, plan) {
  const selected = new Set(selectedDigestTimes(user));
  const timezone = canonicalTimezone(user.timezone) || DEFAULT_TZ;
  const keyboard = [];
  for (let start = 0; start < 24; start += 4) {
    keyboard.push(Array.from({ length: 4 }, (_, index) => {
      const hour = start + index;
      return {
        text: `${selected.has(hour) ? "✓ " : ""}${String(hour).padStart(2, "0")}:00`,
        callback_data: `${DIGEST_TIME_PICK}${hour}`,
      };
    }));
  }
  keyboard.push([{ text: "Done", callback_data: DIGEST_TIME_DONE }]);
  const entitlement = plan.tier === "pro"
    ? `Your Pro plan includes up to ${plan.limits.hours} active daily Digest times.`
    : "Your Free plan includes exactly one active daily Digest time.";
  return {
    text: `<b>${isActivated(user) ? "Digest schedule" : "Guided setup · Step 3 of 3"}</b>\n\n` +
      `Choose in <code>${esc(timezone)}</code>. ${entitlement}\n` +
      "Delivery normally begins within a few minutes after the selected hour.",
    reply_markup: { inline_keyboard: keyboard },
  };
}

function activationPlanName(plan) {
  if (plan.source === "trial") return "XGist Pro Trial";
  if (plan.source === "courtesy") return "XGist Pro · Courtesy access";
  if (plan.source === "administrator") return "XGist Pro · Administrator";
  if (plan.tier === "pro") return "XGist Pro";
  return "XGist Free";
}

function activationKeyboard() {
  return { inline_keyboard: [[
    { text: "Connect channel", callback_data: SETUP_CONNECT_CHANNEL },
    { text: "Not now", callback_data: SETUP_SKIP_CHANNEL },
  ]] };
}

async function activateWithDigestTimes(env, chatId, hours, from) {
  const user = (await loadUser(env, chatId)) || userDefaults();
  const plan = await resolvePlan(env, chatId, user);
  const wasActivated = !!user.setup?.completed_at;
  const selected = [...new Set(hours)].sort((a, b) => a - b);
  if (!selected.length || selected.length > plan.limits.hours) {
    return reply(env, chatId,
      `Your plan includes ${plan.limits.hours} active daily Digest time` +
      `${plan.limits.hours === 1 ? "" : "s"}.`);
  }
  if (plan.tier === "free" && wasActivated &&
      (user.hours || []).length > plan.limits.hours) {
    const current = configurationAccess(user, plan).activeHours[0];
    if (!user.hours.includes(selected[0])) {
      const retained = [...user.hours];
      const index = retained.indexOf(current);
      if (index >= 0) retained[index] = selected[0];
      else retained.push(selected[0]);
      user.hours = [...new Set(retained)];
    }
    user.free_active_hours = selected;
  } else {
    user.hours = selected;
    if (plan.tier === "free") user.free_active_hours = selected;
  }
  updateSetup(user);
  if (!user.sources?.length || !user.setup.timezone_confirmed_at) {
    user.setup.current_step = requiredSetupStep(user);
    user.setup.digest_time_choices = selected;
    delete user.setup.digest_time_confirmed_at;
    await saveUser(env, chatId, user);
    const times = formatDigestTimes(selected);
    return reply(env, chatId,
      `🕘 Digest times saved: ${times}. Finish the earlier Guided setup steps ` +
      "before confirming activation.");
  }
  const now = new Date(Date.now()).toISOString();
  setSetupTimestamp(user, "digest_time_confirmed_at", now);
  if (wasActivated) {
    user.setup.current_step = "complete";
    user.setup.last_activity_at = now;
    delete user.setup.digest_time_choices;
    await saveUser(env, chatId, user);
    const times = formatDigestTimes(selected);
    return reply(env, chatId,
      `🕘 Digest times updated: ${times} in <code>${esc(user.timezone)}</code>.`);
  }
  setSetupTimestamp(user, "activated_at", now);
  user.setup.completed_at = user.setup.completed_at || user.setup.activated_at;
  user.setup.current_step = "complete";
  user.setup.last_activity_at = now;
  user.setup.reminder_consumed = false;
  delete user.setup.digest_time_choices;
  await saveUser(env, chatId, user);
  const name = from?.first_name ? `${esc(from.first_name)}, ` : "";
  const times = formatDigestTimes(selected);
  return reply(env, chatId,
    `✅ <b>Setup complete · ${activationPlanName(plan)}</b>\n\n` +
    `${name}your Digest is active at ${times} in <code>${esc(user.timezone)}</code>.\n` +
    "Private Previews will arrive here. A Publishing channel is optional.",
    { reply_markup: activationKeyboard() });
}

async function showTimezoneStep(env, chatId, user, intro = "") {
  updateSetup(user, { currentStep: "timezone" });
  if (!user.setup.timezone_candidate) {
    user.setup.timezone_candidate = canonicalTimezone(user.timezone) || DEFAULT_TZ;
  }
  await saveUser(env, chatId, user);
  if (user.setup.timezone_candidate) {
    return reply(env, chatId,
      intro + timezoneConfirmationText(user.setup.timezone_candidate, isActivated(user)),
      { reply_markup: timezoneConfirmationKeyboard() });
  }
  return reply(env, chatId,
    intro + "<b>Guided setup · Step 2 of 3</b>\n\n" +
    "Choose the timezone for your Digest times. Send a city such as Kyiv or " +
    "an IANA timezone such as Europe/Kyiv.");
}

async function showDigestTimeStep(env, chatId, user, intro = "") {
  updateSetup(user, { currentStep: "digest_time" });
  if (isActivated(user) && !Array.isArray(user.setup.digest_time_choices)) {
    user.setup.digest_time_choices = [...configurationAccess(
      user, await resolvePlan(env, chatId, user)).activeHours];
  }
  await saveUser(env, chatId, user);
  const plan = await resolvePlan(env, chatId, user);
  const view = digestTimeView(user, plan);
  return reply(env, chatId, intro + view.text,
    { reply_markup: view.reply_markup });
}

async function beginTimezoneResolution(env, chatId, input) {
  const user = (await loadUser(env, chatId)) || userDefaults();
  const timezone = canonicalTimezone(input);
  const choices = timezone
    ? [{ label: timezone.replace(/_/g, " "), zone: timezone }]
    : cityTimezoneChoices(input);
  updateSetup(user, { currentStep: "timezone" });
  delete user.setup.timezone_candidate;
  delete user.setup.timezone_choices;
  if (!choices.length) {
    const fallback = canonicalTimezone(user.timezone) || DEFAULT_TZ;
    user.setup.choosing_timezone = false;
    user.setup.timezone_candidate = fallback;
    await saveUser(env, chatId, user);
    return reply(env, chatId,
      `I couldn’t identify “${esc(input)}”, so your timezone remains ` +
      `<code>${esc(fallback)}</code>. You can confirm it or choose another city.`,
      { reply_markup: timezoneConfirmationKeyboard() });
  }
  if (choices.length > 1) {
    user.setup.choosing_timezone = true;
    user.setup.timezone_choices = choices;
    await saveUser(env, chatId, user);
    return reply(env, chatId,
      `I found more than one match for “${esc(input)}”. Which one did you mean?`,
      { reply_markup: { inline_keyboard: choices.map(({ label }, index) => [{
        text: label, callback_data: `${TIMEZONE_PICK}${index}`,
      }]) } });
  }
  user.setup.choosing_timezone = false;
  user.setup.timezone_candidate = choices[0].zone;
  await saveUser(env, chatId, user);
  return reply(env, chatId, timezoneConfirmationText(choices[0].zone, isActivated(user)),
    { reply_markup: timezoneConfirmationKeyboard() });
}

async function confirmTimezone(env, chatId) {
  const user = await loadUser(env, chatId);
  const timezone = user?.setup?.timezone_candidate;
  if (!user || !timezone) {
    return reply(env, chatId,
      "That timezone choice expired. Send a city or IANA timezone again.");
  }
  const previous = user.timezone;
  const wasActivated = !!user.setup.completed_at;
  user.timezone = timezone;
  setSetupTimestamp(user, "timezone_confirmed_at");
  updateSetup(user, {
    currentStep: wasActivated ? "complete" : requiredSetupStep(user),
  });
  user.setup.choosing_timezone = false;
  delete user.setup.timezone_candidate;
  delete user.setup.timezone_choices;
  await saveUser(env, chatId, user);
  const times = formatDigestTimes(user.hours);
  if (wasActivated && previous && previous !== timezone) {
    return reply(env, chatId,
      `✅ Timezone changed to <code>${esc(timezone)}</code>.\n` +
      `Your Digest times remain ${times || "unset"} in local wall-clock time.`);
  }
  if (user.setup.current_step === "account") {
    return reply(env, chatId,
      `✅ Timezone confirmed: <code>${esc(timezone)}</code>.\n\n` +
      "Continue Guided setup with /add, then send the X account when prompted.");
  }
  return showDigestTimeStep(env, chatId, user,
    `✅ Timezone confirmed: <code>${esc(timezone)}</code>.\n\n`);
}

async function beginAccountValidation(env, chatId, input) {
  const user = (await loadUser(env, chatId)) || userDefaults();
  if (!isActivated(user)) {
    updateSetup(user, { currentStep: "account", addingAccount: true });
    await saveUser(env, chatId, user);
  }
  const handle = normalizeHandle(input);
  if (!handle) {
    return reply(env, chatId,
      "That doesn’t look like an X profile. Send one @handle, bare handle, or profile URL.");
  }
  delete user.settings_input;
  const plan = await resolvePlan(env, chatId, user);
  const current = user.sources || [];
  const replace = current.includes(user.account_replacement?.old_handle)
    ? user.account_replacement.old_handle : null;
  if (user.account_validation?.handle === handle) {
    await saveUser(env, chatId, user);
    return reply(env, chatId,
      `I’m already checking ${xlink(handle)}. I’ll message you when it’s verified.`);
  }
  if (current.includes(handle)) {
    await saveUser(env, chatId, user);
    if (replace) {
      return reply(env, chatId,
        `${xlink(handle)} is already in your Watched accounts. ` +
        `Send a different replacement for ${xlink(replace)}.`);
    }
    return reply(env, chatId,
      `${xlink(handle)} is already in your Watched accounts.\n` +
      `${current.length}/${plan.limits.sources} accounts used.`,
      { reply_markup: setupAccountKeyboard() });
  }
  if (!replace && current.length >= plan.limits.sources) {
    await saveUser(env, chatId, user);
    return reply(env, chatId,
      `Your ${plan.tier === "pro" ? "Pro" : "Free"} plan includes ` +
      `${plan.limits.sources} watched accounts. Remove one first` +
      (plan.tier === "pro" ? "." : " or use /pro for 25."));
  }
  const now = new Date().toISOString();
  if (!replace) updateSetup(user, { currentStep: "account", addingAccount: true });
  user.account_validation = { handle, requested_at: now, ...(replace ? { replace } : {}) };
  await saveUser(env, chatId, user);
  const resp = await dispatchDigest(env,
    { account_handle: handle, only_user: String(chatId) });
  if (resp.status !== 204) {
    delete user.account_validation;
    await saveUser(env, chatId, user);
    return reply(env, chatId,
      `I couldn’t start the account check (HTTP ${resp.status}). Please try again.`);
  }
  return reply(env, chatId,
    `Checking ${xlink(handle)} now. I’ll message you when it’s verified` +
    (replace ? ` as the replacement for ${xlink(replace)}.` : "."));
}

function accountValidationFailure(handle, outcome, replacement = null) {
  const suffix = replacement
    ? ` Send another replacement for ${xlink(replacement)}.` : "";
  const messages = {
    nonexistent: `I couldn’t find ${xlink(handle)}. Check the spelling and try again.`,
    protected: `${xlink(handle)} is protected, so I can’t read its posts. Try a public account.`,
    unreadable: `${xlink(handle)} exists, but its posts aren’t readable right now. Try another account.`,
    transient: `X couldn’t verify ${xlink(handle)} right now. Nothing was saved; please try again.`,
  };
  return (messages[outcome] || messages.transient) + suffix;
}

function clearAccountHealth(user, handle) {
  if (!user.account_health) return;
  delete user.account_health[handle];
  if (!Object.keys(user.account_health).length) delete user.account_health;
}

async function handleAccountValidation(result, env) {
  const chatId = Number(result.chat_id);
  const handle = normalizeHandle(result.handle);
  if (!Number.isSafeInteger(chatId) || !handle) return;
  const user = await loadUser(env, chatId);
  if (!user || user.account_validation?.handle !== handle) return;
  const replacement = user.account_validation.replace || null;
  delete user.account_validation;
  if (replacement) {
    const index = user.sources?.indexOf(replacement) ?? -1;
    if (result.outcome === "readable" && index >= 0 && !user.sources.includes(handle)) {
      user.sources[index] = handle;
      if (user.free_active_sources?.includes(replacement)) {
        user.free_active_sources = user.free_active_sources.map((source) =>
          source === replacement ? handle : source);
      }
      clearAccountHealth(user, replacement);
      delete user.account_replacement;
      await saveUser(env, chatId, user);
      return reply(env, chatId,
        `✅ ${xlink(replacement)} was replaced with verified ${xlink(handle)}. ` +
        "Your other Watched accounts are unchanged.");
    }
    if (result.outcome === "readable") {
      delete user.account_replacement;
      await saveUser(env, chatId, user);
      return reply(env, chatId,
        "The Watched accounts changed while verification was running, so nothing was replaced.");
    }
    await saveUser(env, chatId, user);
    return reply(env, chatId,
      accountValidationFailure(handle, result.outcome, replacement));
  }
  updateSetup(user, { addingAccount: false });
  if (result.outcome === "readable") {
    const plan = await resolvePlan(env, chatId, user);
    user.sources = user.sources || [];
    if (user.sources.includes(handle)) {
      user.setup.current_step = requiredSetupStep(user);
      await saveUser(env, chatId, user);
      return reply(env, chatId,
        `${xlink(handle)} is already in your Watched accounts.\n` +
        `${user.sources.length}/${plan.limits.sources} accounts used.`,
        { reply_markup: setupAccountKeyboard() });
    }
    if (user.sources.length >= plan.limits.sources) {
      user.setup.current_step = requiredSetupStep(user);
      await saveUser(env, chatId, user);
      return reply(env, chatId,
        `${xlink(handle)} is readable, but your ${plan.limits.sources}-account ` +
        "plan limit was reached before the check finished. Nothing was saved.",
        { reply_markup: setupAccountKeyboard() });
    }
    user.sources.push(handle);
    setSetupTimestamp(user, "first_valid_account_at");
    user.setup.current_step = requiredSetupStep(user);
    await saveUser(env, chatId, user);
    return reply(env, chatId,
      `✅ ${xlink(handle)} is verified and now watched.\n` +
      `${user.sources.length}/${plan.limits.sources} accounts used.`,
      { reply_markup: setupAccountKeyboard() });
  }
  user.setup.current_step = "account";
  await saveUser(env, chatId, user);
  return reply(env, chatId, accountValidationFailure(handle, result.outcome),
    { reply_markup: { inline_keyboard: [[
      { text: "Try another account", callback_data: "ga" },
    ]] } });
}

async function createProInvoiceLink(env) {
  const price = Number(env.PRO_PRICE_STARS || 550);
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
  return { price, res };
}

async function sendProOffer(env, chatId, intro = "") {
  const { price, res } = await createProInvoiceLink(env);
  if (!res.ok) return res;
  return reply(env, chatId,
    intro +
    `⭐ <b>XGist Pro</b> — ${price} Stars / month\n` +
    `6 digest times a day · 25 watched accounts\n` +
    `Renews automatically; cancel anytime in Telegram Settings → My Stars.`,
    { reply_markup: { inline_keyboard: [[
      { text: `⭐ Subscribe — ${price} Stars/mo`, url: res.result },
    ]] } });
}

async function sendProInvites(env) {
  const ids = (await redis(env, "SMEMBERS", "uids")) || [];
  if (!ids.length) return;
  const [raws, whitelist, promo] = await Promise.all([
    redis(env, "MGET", ...ids.map((id) => `user:${id}`)),
    redis(env, "SMEMBERS", "whitelist"),
    redis(env, "SMEMBERS", "promo"),
  ]);
  const whitelisted = new Set(whitelist || []);
  const promotional = new Set(promo || []);
  const now = Date.now();
  for (let i = 0; i < ids.length; i++) {
    if (!raws[i]) continue;
    const id = ids[i];
    const user = JSON.parse(raws[i]);
    const plan = effectivePlan(user, {
      isAdmin: String(id) === String(env.ADMIN_ID),
      whitelisted: whitelisted.has(id),
      promotional: promotional.has(id),
    });
    if (plan.tier === "pro") {
      if (!user.pro_access_seen_at || user.free_since || user.pro_invite_sent_at ||
          user.downgrade_notified_at) {
        user.pro_access_seen_at = new Date(now).toISOString();
        delete user.free_since;
        delete user.pro_invite_sent_at;
        delete user.downgrade_notified_at;
        await saveUser(env, id, user);
      }
      continue;
    }
    const excess = (user.sources || []).length > plan.limits.sources ||
      (user.hours || []).length > plan.limits.hours;
    if (excess) {
      const previousSources = JSON.stringify(user.free_active_sources || null);
      const previousHours = JSON.stringify(user.free_active_hours || null);
      ensureFreeSelections(user, plan);
      if (previousSources !== JSON.stringify(user.free_active_sources) ||
          previousHours !== JSON.stringify(user.free_active_hours)) {
        await saveUser(env, id, user);
      }
      const hadProAccess = !!(user.paid_until || user.pro_source || user.pro_access_seen_at);
      if (hadProAccess && !user.downgrade_notified_at) {
        const view = downgradeView(user, plan);
        const sent = await reply(env, Number(id), view.text,
          { reply_markup: view.reply_markup });
        if (sent.ok) {
          user.downgrade_notified_at = new Date(now).toISOString();
          await saveUser(env, id, user);
        }
      }
    }
    if (!user.free_since) {
      const expiredAt = Date.parse(user.paid_until);
      user.free_since = new Date(Number.isFinite(expiredAt) ? expiredAt : now).toISOString();
      await saveUser(env, id, user);
    }
    if (user.pro_invite_sent_at || Date.parse(user.free_since) > now - 86400 * 1000) {
      continue;
    }
    const sent = await sendProOffer(env, id,
      "Ready for more? Upgrade your free plan and unlock:\n\n");
    if (sent.ok) {
      user.pro_invite_sent_at = new Date(now).toISOString();
      await saveUser(env, id, user);
    }
  }
}

const SETUP_REMINDER_DELAY = 24 * 60 * 60 * 1000;

function setupReminderView(user, plan) {
  const step = requiredSetupStep(user);
  const intro = `⏰ <b>${activationPlanName(plan)} setup reminder</b>\n\n`;
  if (step === "account") {
    return { step, text: intro + accountStepText(plan), reply_markup: MENU };
  }
  if (step === "timezone") {
    if (user.setup.timezone_candidate) {
      return {
        step, text: intro + timezoneConfirmationText(user.setup.timezone_candidate),
        reply_markup: timezoneConfirmationKeyboard(),
      };
    }
    return {
      step,
      text: intro + "<b>Guided setup · Step 2 of 3</b>\n\n" +
        "Choose the timezone for your Digest times. Send a city such as Kyiv or " +
        "an IANA timezone such as Europe/Kyiv.",
    };
  }
  const view = digestTimeView(user, plan);
  return { step, text: intro + view.text, reply_markup: view.reply_markup };
}

async function sendSetupReminders(env) {
  const ids = (await redis(env, "SMEMBERS", "uids")) || [];
  if (!ids.length) return;
  const raws = await redis(env, "MGET", ...ids.map((id) => `user:${id}`));
  const now = Date.now();
  for (let index = 0; index < ids.length; index++) {
    if (!raws[index]) continue;
    const user = JSON.parse(raws[index]);
    const setup = user.setup;
    const activityAt = Date.parse(setup?.last_activity_at || setup?.started_at || "");
    if (user.setup_reminder_eligible !== true || !setup || isActivated(user) ||
        setup.reminder_consumed || !Number.isFinite(activityAt) ||
        now - activityAt < SETUP_REMINDER_DELAY) continue;
    const plan = await resolvePlan(env, ids[index], user);
    const view = setupReminderView(user, plan);
    const attemptedAt = new Date(now).toISOString();
    setup.reminder_consumed = true;
    setup.reminder_attempted_at = attemptedAt;
    setup.abandonment_step = view.step;
    await saveUser(env, ids[index], user);
    const result = await reply(env, Number(ids[index]), view.text,
      view.reply_markup ? { reply_markup: view.reply_markup } : {});
    if (result.ok) {
      setup.reminder_delivered_at = attemptedAt;
      await saveUser(env, ids[index], user);
    }
  }
}

/* ---------------- Commands ---------------- */

function userDefaults() {
  return { channel: null, sources: [], hours: [9], timezone: null,
           limit: 3, interests: null, style: null, language: "en", paused: false,
           setup_reminder_eligible: true };
}

function channelRetryKeyboard() {
  return { inline_keyboard: [[
    { text: "Try again", callback_data: CHANNEL_RETRY },
  ]] };
}

function channelConfirmationKeyboard() {
  return { inline_keyboard: [[
    { text: "Publish now", callback_data: CHANNEL_PUBLISH },
    { text: "Not now", callback_data: CHANNEL_NOT_NOW },
  ]] };
}

async function verifyPublishingChannel(env, chatId, candidate) {
  const user = (await loadUser(env, chatId)) || userDefaults();
  user.channel_candidate = candidate;
  await saveUser(env, chatId, user);
  const label = esc(String(candidate.title || candidate.id));
  const bot = await tg(env, "getMe", {});
  const membership = bot.ok && await tg(env, "getChatMember", {
    chat_id: candidate.id, user_id: bot.result.id,
  });
  let repair = null;
  if (!membership?.ok || ["left", "kicked"].includes(membership.result?.status)) {
    repair = `I can’t access ${label}. Add me to that Publishing channel as an ` +
      "administrator with <b>Post Messages</b> enabled, then tap Try again.";
  } else if (membership.result.status !== "administrator") {
    repair = `I’m in ${label}, but I’m not an administrator. Promote me to ` +
      "administrator, enable <b>Post Messages</b>, then tap Try again.";
  } else if (!membership.result.can_post_messages) {
    repair = `I’m an administrator in ${label}, but I can’t post messages. ` +
      "Enable <b>Post Messages</b>, then tap Try again.";
  }
  if (repair) {
    return reply(env, chatId, repair,
      { reply_markup: channelRetryKeyboard() });
  }
  user.channel = candidate.id;
  user.channel_verified = {
    id: candidate.id, at: new Date(Date.now()).toISOString(),
  };
  delete user.settings_input;
  delete user.channel_candidate;
  if (user.setup) {
    user.setup.reminder_consumed = true;
    user.setup.channel_choice = "connected";
    setSetupTimestamp(user, "channel_connected_at");
  }
  await saveUser(env, chatId, user);
  if (user.publishing_intent) {
    await tg(env, "editMessageReplyMarkup", {
      chat_id: chatId, message_id: user.publishing_intent.control,
      reply_markup: channelConfirmationKeyboard(),
    });
    return reply(env, chatId,
      `✅ Publishing channel verified: ${label}. Return to the preserved Preview ` +
      "and choose <b>Publish now</b> or <b>Not now</b>.",
      { reply_to_message_id: user.publishing_intent.control });
  }
  return reply(env, chatId, `✅ Publishing channel verified: ${label}.`);
}

async function accountSettingsView(env, chatId) {
  const user = (await loadUser(env, chatId)) || userDefaults();
  const plan = await resolvePlan(env, chatId, user);
  const sources = user.sources || [];
  const keyboard = [[{ text: "➕ Add account", callback_data: ACCOUNT_ADD }]];
  if (sources.length) {
    keyboard.push([{ text: "🗑 Remove accounts", callback_data: ACCOUNT_REMOVE_OPEN }]);
  }
  return {
    text: "👀 <b>Watched accounts</b>\n\n" +
      (sources.length ? sources.map(xlink).join("\n") : "No accounts added yet.") +
      `\n\n${sources.length}/${plan.limits.sources} accounts used.`,
    reply_markup: { inline_keyboard: keyboard },
  };
}

function accountRemovalView(user) {
  const sources = user.sources || [];
  const selected = new Set(user.account_removal_choices || []);
  const keyboard = [];
  for (let index = 0; index < sources.length; index += 2) {
    keyboard.push(sources.slice(index, index + 2).map((source, offset) => ({
      text: `${selected.has(source) ? "✓ " : ""}@${source}`,
      callback_data: `${ACCOUNT_REMOVE_PICK}${index + offset}`,
    })));
  }
  keyboard.push([{ text: "Done", callback_data: ACCOUNT_REMOVE_DONE }]);
  return {
    text: "🗑 <b>Remove Watched accounts</b>\n\n" +
      "Select every account you want to remove, then tap Done.\n" +
      `Selected: ${selected.size}`,
    reply_markup: { inline_keyboard: keyboard },
  };
}

async function promptAccountInput(env, chatId) {
  const user = (await loadUser(env, chatId)) || userDefaults();
  user.settings_input = "account";
  await saveUser(env, chatId, user);
  return reply(env, chatId,
    "Send the X account you want to watch: an @handle, bare handle, or X profile URL.");
}

function channelSettingsView(user) {
  const keyboard = [[{
    text: user.channel ? "Replace channel" : "Connect channel",
    callback_data: CHANNEL_CONNECT,
  }]];
  if (user.channel) {
    keyboard.push([{ text: "Disconnect channel", callback_data: CHANNEL_DISCONNECT }]);
  }
  return {
    text: "📢 <b>Publishing channel</b>\n\n" +
      `Current: ${user.channel ? esc(String(user.channel)) : "not connected"}\n\n` +
      "Private Previews still arrive here without a Publishing channel.",
    reply_markup: { inline_keyboard: keyboard },
  };
}

async function showChannelSettings(env, chatId) {
  const user = (await loadUser(env, chatId)) || userDefaults();
  const view = channelSettingsView(user);
  return reply(env, chatId, view.text, { reply_markup: view.reply_markup });
}

async function promptChannelInput(env, chatId) {
  const user = (await loadUser(env, chatId)) || userDefaults();
  user.settings_input = "channel";
  await saveUser(env, chatId, user);
  return reply(env, chatId,
    "Add me to the Publishing channel as an administrator with Post Messages enabled. " +
    "Then send its @username or forward me a message from a private channel.");
}

function languageSettingsView(user) {
  const languages = [["en", "English"], ["uk", "Ukrainian"], ["ru", "Russian"]];
  const current = user.language || "en";
  return {
    text: "🌐 <b>Post language</b>\n\nChoose the language used for generated posts.",
    reply_markup: { inline_keyboard: [languages.map(([code, label]) => ({
      text: `${current === code ? "✓ " : ""}${label}`,
      callback_data: `${LANGUAGE_PICK}${code}`,
    }))] },
  };
}

function limitSettingsView(user) {
  const current = user.limit || 3;
  return {
    text: "🔢 <b>Posts per Digest</b>\n\nChoose the maximum number of posts in each Digest.",
    reply_markup: { inline_keyboard: [[1, 2, 3, 4, 5].map((limit) => ({
      text: `${current === limit ? "✓ " : ""}${limit}`,
      callback_data: `${LIMIT_PICK}${limit}`,
    }))] },
  };
}

function styleSettingsView(user) {
  return {
    text: "✍️ <b>Caption style</b>\n\n" +
      `Current: ${user.style ? esc(user.style) : "default"}`,
    reply_markup: { inline_keyboard: [
      [{ text: "Set custom style", callback_data: STYLE_CUSTOM }],
      [{ text: "Use default", callback_data: STYLE_DEFAULT }],
    ] },
  };
}

async function showStyleSettings(env, chatId) {
  const user = (await loadUser(env, chatId)) || userDefaults();
  const view = styleSettingsView(user);
  return reply(env, chatId, view.text, { reply_markup: view.reply_markup });
}

/** The /settings body + its inline pause/resume toggle. Shared between the
 *  /settings command and the toggle callback so both render identically and
 *  the callback can edit the message in place. */
async function settingsView(env, chatId) {
  const u = (await loadUser(env, chatId)) || userDefaults();
  const plan = await resolvePlan(env, chatId, u);
  const presentation = planPresentation(plan);
  const langNames = { en: "English", uk: "Ukrainian", ru: "Russian" };
  const paused = !!u.paused;
  const lines = [
    "⚙️ <b>Settings</b>",
    "",
    `📢 Publishing channel: ${u.channel ? esc(String(u.channel)) : "not connected"}`,
    ...configurationLines(u, plan),
    `🌍 Timezone: ${u.timezone ? esc(u.timezone) : "Europe/Kyiv (default)"}`,
    `🌐 Language: ${langNames[u.language || "en"]}`,
    `✍️ Style: ${u.style ? esc(u.style) : "default"}`,
    `🔢 Posts per digest: ${u.limit || 3}`,
    `${presentation.label}\n${presentation.details}\nMaximum: ${planCapacity(plan)}`,
    paused ? "⏸ Digest: Paused" : "▶️ Digest: Active",
  ];
  return {
    text: lines.join("\n"),
    reply_markup: { inline_keyboard: [
      [
        { text: "Accounts", callback_data: `${SETUP_EDIT}accounts` },
        { text: "Digest schedule", callback_data: `${SETUP_EDIT}times` },
      ],
      [
        { text: "Timezone", callback_data: `${SETUP_EDIT}timezone` },
        { text: "Publishing channel", callback_data: `${SETUP_EDIT}channel` },
      ],
      [
        { text: "Language", callback_data: `${SETUP_EDIT}language` },
        { text: "Caption style", callback_data: `${SETUP_EDIT}style` },
      ],
      [
        { text: "Posts per Digest", callback_data: `${SETUP_EDIT}limit` },
      ],
      [
        { text: paused ? "▶️ Resume digests" : "⏸ Pause digests",
          callback_data: "pt" },
      ],
    ] },
  };
}

// Rolling-24h thread-post quota, charged in quota:<id> (mirrored in
// pipeline/config.py, which DECRs it if the fetch fails). Charge-then-check so
// two quick pastes can't both slip under the cap; refund here if we reject or
// the dispatch fails, and let the pipeline refund a failed *fetch*.
async function handleThreadLink(env, chatId, from, url) {
  const isAdmin = isAdminUser(from, env);
  let user = null;
  try {
    user = await loadUser(env, chatId);
  } catch (err) {
    console.log("thread: user load failed:", err);
  }
  const plan = await resolvePlan(env, chatId, user);
  const pro = plan.tier === "pro";
  const limit = isAdmin ? Infinity : plan.limits.thread_posts;

  let used;
  try {
    used = await redis(env, "INCR", `quota:${chatId}`);
    if (used === 1) await redis(env, "EXPIRE", `quota:${chatId}`, 86400);
  } catch (err) {
    console.log("thread: quota charge failed:", err);
    return reply(env, chatId, "Storage hiccup, please try again.");
  }

  const refund = async () => {
    try {
      await redis(env, "DECR", `quota:${chatId}`);
    } catch (err) {
      console.log("thread: quota refund failed:", err);
    }
  };

  if (used > limit) {
    await refund();
    return reply(env, chatId,
      `🧵 That's today's thread limit (${limit}/day). It resets within 24h` +
      (pro ? "." : ` — or /pro for ${LIMITS.pro.thread_posts}/day.`));
  }

  const resp = await dispatchDigest(env,
    { thread_url: url, only_user: String(chatId) });
  if (resp.status !== 204) {
    const detail = await resp.text();
    console.log("thread dispatch failed:", resp.status, detail);
    await refund();
    return reply(env, chatId,
      `Couldn't start the thread fetch (HTTP ${resp.status}). Please try again.`);
  }
  return reply(env, chatId, "🧵 Fetching that thread — preview in ~1–2 min.");
}

async function handleMessage(msg, env, ctx) {
  if (msg.chat.type !== "private") return;
  const chatId = msg.chat.id;

  const fwd = msg.forward_origin;
  if (fwd?.type === "channel") {
    return verifyPublishingChannel(env, chatId,
      { id: fwd.chat.id, title: fwd.chat.title });
  }

  // Payment confirmation arrives as a service message, not a command.
  if (msg.successful_payment) {
    const sp = msg.successful_payment;
    const until = sp.subscription_expiration_date
      ? new Date(sp.subscription_expiration_date * 1000)
      : new Date(Date.now() + 31 * 86400 * 1000);
    await setField(env, chatId, (u) => {
      u.paid_until = until.toISOString();
      u.pro_source = "paid";
      delete u.free_since;
      delete u.pro_invite_sent_at;
    },
      `⭐ <b>XGist Pro</b>\n` +
      `Your subscription is active until <b>${until.toISOString().slice(0, 10)}</b>.\n` +
      `You now have ${LIMITS.pro.sources} watched accounts and ` +
      `${LIMITS.pro.hours} Digest times/day.\n` +
      `Next: review your Pro setup with /settings. ` +
      `Manage renewal in Telegram Settings → My Stars.`);
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
  let editLoadFailed = false;
  if (!commandish && (msg.text || msg.caption || msg.photo || msg.video)) {
    let editing = null;
    try {
      editing = (await loadUser(env, chatId))?.editing;
    } catch (err) {
      console.log("config load failed:", err);
      editLoadFailed = true;
    }
    if (editing && editing.until > Date.now()) {
      return handleEditContent(msg, editing, env, ctx);
    }
  }

  if (!commandish && msg.text) {
    const user = await loadUser(env, chatId);
    if (user?.settings_input === "channel") {
      const input = msg.text.trim();
      if (!/^@[a-zA-Z0-9_]{4,}$/.test(input) && !/^-100\d+$/.test(input)) {
        return reply(env, chatId,
          "I couldn’t identify that channel. Send its @username or forward a message " +
          "from the channel. Your existing channel is unchanged.");
      }
      const value = input.startsWith("@") ? input : Number(input);
      return verifyPublishingChannel(env, chatId, { id: value, title: input });
    }
    if (user?.settings_input === "style") {
      const style = msg.text.trim();
      user.style = style || null;
      delete user.settings_input;
      await saveUser(env, chatId, user);
      return reply(env, chatId,
        style ? `✅ Caption style saved: ${esc(style)}` : "✅ Default caption style restored.");
    }
    if (user?.settings_input === "account") {
      return beginAccountValidation(env, chatId, msg.text);
    }
  }

  // Paste-a-link → thread post. Deliberately after the ✏️-edit capture above
  // (a link pasted mid-Edit is edit content, not a new thread) and before the
  // command switch. Skipped for commands so "/foo …x.com/…/status/…" isn't
  // hijacked; a plain message that merely contains a tweet link triggers it.
  // If the edit-state load above failed we can't tell a mid-Edit paste from a
  // fresh link, so we don't trigger (and don't charge quota) on a hiccup.
  if (!commandish && !editLoadFailed) {
    const tweetUrl = firstTweetUrl(msg.text || msg.caption);
    if (tweetUrl) return handleThreadLink(env, chatId, msg.from, tweetUrl);
  }

  if (!commandish && msg.text) {
    const user = await loadUser(env, chatId);
    if (user?.account_replacement) {
      return beginAccountValidation(env, chatId, msg.text);
    }
    if (user?.setup?.current_step === "account" || user?.setup?.adding_account) {
      return beginAccountValidation(env, chatId, msg.text);
    }
    if (user?.setup?.current_step === "timezone" || user?.setup?.choosing_timezone) {
      return beginTimezoneResolution(env, chatId, msg.text);
    }
  }

  if (!msg.text) return;
  const text = MENU_BUTTONS[msg.text.trim()] || msg.text.trim();
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const arg = rest.join(" ").trim();
  const isAdmin = isAdminUser(msg.from, env);

  switch (cmd) {
    case "/start": {
      let promoGranted = false;
      if (!isAdmin) {
        promoGranted = await maybeGrantPromo(env, chatId);
      }
      let user = await loadUser(env, chatId);
      const plan = await resolvePlan(env, chatId, user);
      if (!isAdmin && plan.tier === "free") {
        await registerFreeUser(env, chatId, plan);
        user = await loadUser(env, chatId);
      }
      const requiredStep = requiredSetupStep(user);
      if (isActivated(user)) {
        const view = homeView(user, plan, msg.from.first_name);
        await reply(env, chatId, view.text,
          { reply_markup: view.reply_markup });
      } else if (requiredStep === "account") {
        const entry = user || userDefaults();
        updateSetup(entry, { currentStep: "account" });
        await saveUser(env, chatId, entry);
        await reply(env, chatId,
          planWelcome(plan) + "\n\n" + accountStepText(plan),
          { reply_markup: MENU });
      } else if (requiredStep === "timezone") {
        await showTimezoneStep(env, chatId, user, planWelcome(plan) + "\n\n");
      } else if (requiredStep === "digest_time" && !user?.setup?.completed_at) {
        await showDigestTimeStep(env, chatId, user, planWelcome(plan) + "\n\n");
      } else {
        const view = homeView(user, plan, msg.from.first_name);
        await reply(env, chatId, view.text,
          { reply_markup: view.reply_markup });
      }
      if (promoGranted && env.ADMIN_ID) {
        await reply(env, Number(env.ADMIN_ID),
          `🎁 Promo slot used by id ${chatId}` +
          (msg.from.username ? ` (@${esc(msg.from.username)})` : ""));
      }
      return;
    }

    case "/setup":
    case "/help":
      return;

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
      const plan = await resolvePlan(env, chatId, u);
      if (plan.tier === "pro") {
        const presentation = planPresentation(plan);
        return reply(env, chatId,
          `${presentation.label}\n${presentation.details}\n` +
          "Next: review your Pro setup with /settings.");
      }
      const res = await sendProOffer(env, chatId);
      if (!res.ok) {
        return reply(env, chatId,
          `Couldn't create the invoice: ${esc(res.description || "unknown error")}`);
      }
      return res;
    }

    case "/channel": {
      return showChannelSettings(env, chatId);
    }

    case "/add": {
      return promptAccountInput(env, chatId);
    }

    case "/remove": {
      const user = (await loadUser(env, chatId)) || userDefaults();
      if (!user.sources?.length) {
        const view = await accountSettingsView(env, chatId);
        return reply(env, chatId, view.text, { reply_markup: view.reply_markup });
      }
      user.account_removal_choices = [];
      await saveUser(env, chatId, user);
      const view = accountRemovalView(user);
      return reply(env, chatId, view.text, { reply_markup: view.reply_markup });
    }

    case "/list": {
      const view = await accountSettingsView(env, chatId);
      return reply(env, chatId, view.text, { reply_markup: view.reply_markup });
    }

    case "/times":
    case "/schedule": {
      const user = (await loadUser(env, chatId)) || userDefaults();
      return showDigestTimeStep(env, chatId, user);
    }

    case "/timezone": {
      const user = (await loadUser(env, chatId)) || userDefaults();
      return showTimezoneStep(env, chatId, user);
    }

    case "/limit": {
      const user = (await loadUser(env, chatId)) || userDefaults();
      const view = limitSettingsView(user);
      return reply(env, chatId, view.text, { reply_markup: view.reply_markup });
    }

    case "/lang":
    case "/language": {
      const user = (await loadUser(env, chatId)) || userDefaults();
      const view = languageSettingsView(user);
      return reply(env, chatId, view.text, { reply_markup: view.reply_markup });
    }

    // Hidden power-user command: steers what "interesting" means.
    case "/interests":
      return setField(env, chatId, (u) => { u.interests = arg || null; },
        arg ? "Interests saved." : "Interests cleared.");

    case "/style":
    case "/post_style":
      return showStyleSettings(env, chatId);

    case "/settings": {
      const view = await settingsView(env, chatId);
      return reply(env, chatId, view.text, { reply_markup: view.reply_markup });
    }

    case "/whitelist":
    case "/unwhitelist": {
      if (!isAdmin) return reply(env, chatId, "Unknown command. Use /settings.");
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
      if (!isAdmin) return reply(env, chatId, "Unknown command. Use /settings.");
      const list = ((await redis(env, "SMEMBERS", "whitelist")) || []).sort();
      return reply(env, chatId, list.length ? list.join("\n") : "Whitelist is empty.");
    }

    case "/gen_digest_now": {
      if (!isAdmin) return reply(env, chatId, "Unknown command. Use /settings.");
      const resp = await dispatchDigest(env, { only_user: String(chatId) });
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
      if (!isAdmin) return reply(env, chatId, "Unknown command. Use /settings.");
      const ids = ((await redis(env, "SMEMBERS", "uids")) || []).sort();
      if (!ids.length) return reply(env, chatId, "No users yet.");
      const raws = await redis(env, "MGET", ...ids.map((id) => `user:${id}`));
      const wl = new Set((await redis(env, "SMEMBERS", "whitelist")) || []);
      const promo = new Set((await redis(env, "SMEMBERS", "promo")) || []);
      const lines = ids.flatMap((id, i) => {
        if (!raws[i]) return [];
        const u = JSON.parse(raws[i]);
        const access = effectivePlan(u, {
          isAdmin: String(id) === String(env.ADMIN_ID),
          whitelisted: wl.has(id),
          promotional: promo.has(id),
        });
        const plan = access.tier === "pro"
          ? planPresentation(access).label.replace(/<\/?b>/g, "") : "🆓 free";
        return `${id} → ${esc(String(u.channel || "no channel"))}, ` +
               `${(u.sources || []).length} sources, ${(u.hours || []).length} time(s)/day · ${plan}`;
      });
      return reply(env, chatId, lines.length ? lines.join("\n") : "No users yet.");
    }

    default:
      return reply(env, chatId, "Unknown command. Use /settings.");
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

async function recordFirstPublish(env, chatId, user) {
  if (!user.setup || user.setup.first_publish_at) return;
  setSetupTimestamp(user, "first_publish_at");
  await saveUser(env, chatId, user);
}

async function publishPreview(env, chatId, controlId, idsStr, user) {
  const ids = idsStr.split(",").map(Number).sort((a, b) => a - b);
  const result = await tg(env, "copyMessages", {
    chat_id: user.channel, from_chat_id: chatId, message_ids: ids,
  });
  if (!result.ok) {
    await reply(env, chatId,
      `Publishing failed: ${esc(result.description || "unknown error")}. ` +
      "The Preview is still available.");
    return false;
  }
  await recordFirstPublish(env, chatId, user);
  const dest = typeof user.channel === "string" ? user.channel : "your channel";
  await tg(env, "editMessageText", {
    chat_id: chatId, message_id: controlId, text: `✅ Posted to ${dest}`,
  });
  await recordFeedback(env, chatId, idsStr, "approved");
  return true;
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
  const editDowngrade = (user, plan) => {
    const view = downgradeView(user, plan);
    return tg(env, "editMessageText", {
      chat_id: chatId, message_id: controlId, text: view.text,
      parse_mode: "HTML", reply_markup: view.reply_markup,
      link_preview_options: { is_disabled: true },
    });
  };

  if (cb.data === NAV_SETUP) {
    await answer("");
    const view = await settingsView(env, chatId);
    return reply(env, chatId, view.text, { reply_markup: view.reply_markup });
  }

  const isDowngradeCallback = cb.data === DOWNGRADE_DONE ||
    cb.data.startsWith(DOWNGRADE_SOURCE) || cb.data.startsWith(DOWNGRADE_HOUR);
  let downgradeContext;
  if (isDowngradeCallback) {
    const user = await loadUser(env, chatId);
    if (!user) return answer("That selection expired.", true);
    const plan = await resolvePlan(env, chatId, user);
    if (plan.tier === "pro") {
      await answer("Pro access restored");
      return reply(env, chatId,
        "⭐ Pro access is active again. All retained configuration is active.");
    }
    downgradeContext = { user, plan };
  }

  if (cb.data.startsWith(DOWNGRADE_SOURCE)) {
    const { user, plan } = downgradeContext;
    ensureFreeSelections(user, plan);
    const index = Number(cb.data.slice(DOWNGRADE_SOURCE.length));
    const source = user.sources?.[index];
    if (!source) return answer("That account is no longer configured.", true);
    const selected = new Set(user.free_active_sources);
    if (selected.has(source)) selected.delete(source);
    else if (selected.size < Math.min(plan.limits.sources, user.sources.length)) {
      selected.add(source);
    } else {
      return answer("Deselect an active account first.", true);
    }
    user.free_active_sources = [...selected];
    await saveUser(env, chatId, user);
    await answer("");
    return editDowngrade(user, plan);
  }

  if (cb.data.startsWith(DOWNGRADE_HOUR)) {
    const { user, plan } = downgradeContext;
    const hour = Number(cb.data.slice(DOWNGRADE_HOUR.length));
    if (!user.hours?.includes(hour)) {
      return answer("That Digest time is no longer configured.", true);
    }
    user.free_active_hours = [hour];
    await saveUser(env, chatId, user);
    await answer("");
    return editDowngrade(user, plan);
  }

  if (cb.data === DOWNGRADE_DONE) {
    const { user, plan } = downgradeContext;
    const sources = [...new Set(user.sources || [])];
    const hours = [...new Set(user.hours || [])];
    const selectedSources = [...new Set(user.free_active_sources || [])]
      .filter((source) => sources.includes(source));
    const selectedHours = [...new Set(user.free_active_hours || [])]
      .filter((hour) => hours.includes(hour));
    if (selectedSources.length !== Math.min(plan.limits.sources, sources.length) ||
        selectedHours.length !== Math.min(plan.limits.hours, hours.length)) {
      return answer("Select the required active accounts and Digest time first.", true);
    }
    user.free_active_sources = selectedSources;
    user.free_active_hours = selectedHours;
    await saveUser(env, chatId, user);
    await answer("Free configuration saved");
    return tg(env, "editMessageText", {
      chat_id: chatId, message_id: controlId,
      text: "✅ <b>Free configuration saved</b>\n\n" +
        configurationLines(user, plan).join("\n"),
      parse_mode: "HTML", reply_markup: { inline_keyboard: [] },
      link_preview_options: { is_disabled: true },
    });
  }

  const isAccountRecovery = cb.data.startsWith(ACCOUNT_KEEP) ||
    cb.data.startsWith(ACCOUNT_REPLACE);
  let accountRecoveryContext;
  if (isAccountRecovery) {
    await answer("");
    const prefix = cb.data.startsWith(ACCOUNT_KEEP) ? ACCOUNT_KEEP : ACCOUNT_REPLACE;
    const handle = normalizeHandle(cb.data.slice(prefix.length));
    const user = await loadUser(env, chatId);
    const health = handle && user?.account_health?.[handle];
    if (!health?.needs_attention || !user.sources?.includes(handle)) {
      return reply(env, chatId,
        "That Watched account has already recovered or is no longer configured.");
    }
    accountRecoveryContext = { user, handle, health };
  }

  if (cb.data.startsWith(ACCOUNT_KEEP)) {
    const { user, handle, health } = accountRecoveryContext;
    health.keep_trying_at = new Date(Date.now()).toISOString();
    await saveUser(env, chatId, user);
    return tg(env, "editMessageText", {
      chat_id: chatId, message_id: controlId,
      text: `✅ I’ll keep trying ${xlink(handle)}. A successful read will clear its attention state.`,
      parse_mode: "HTML", reply_markup: { inline_keyboard: [] },
      link_preview_options: { is_disabled: true },
    });
  }

  if (cb.data.startsWith(ACCOUNT_REPLACE)) {
    const { user, handle } = accountRecoveryContext;
    user.account_replacement = {
      old_handle: handle,
      requested_at: new Date(Date.now()).toISOString(),
    };
    await saveUser(env, chatId, user);
    await tg(env, "editMessageReplyMarkup", {
      chat_id: chatId, message_id: controlId,
      reply_markup: { inline_keyboard: [] },
    });
    return reply(env, chatId,
      `Send the X account that should replace ${xlink(handle)}. ` +
      "I’ll verify it before changing your Watched accounts.");
  }

  if (cb.data.startsWith(SETUP_EDIT)) {
    await answer("");
    const action = cb.data.slice(SETUP_EDIT.length);
    if (action === "accounts") {
      const view = await accountSettingsView(env, chatId);
      return reply(env, chatId, view.text, { reply_markup: view.reply_markup });
    }
    if (action === "timezone") {
      const user = (await loadUser(env, chatId)) || userDefaults();
      return showTimezoneStep(env, chatId, user);
    }
    if (action === "times") {
      const user = (await loadUser(env, chatId)) || userDefaults();
      return showDigestTimeStep(env, chatId, user);
    }
    if (action === "channel") return showChannelSettings(env, chatId);
    if (action === "language") {
      const user = (await loadUser(env, chatId)) || userDefaults();
      const view = languageSettingsView(user);
      return reply(env, chatId, view.text, { reply_markup: view.reply_markup });
    }
    if (action === "style") return showStyleSettings(env, chatId);
    if (action === "limit") {
      const user = (await loadUser(env, chatId)) || userDefaults();
      const view = limitSettingsView(user);
      return reply(env, chatId, view.text, { reply_markup: view.reply_markup });
    }
    return;
  }

  if (cb.data === ACCOUNT_ADD) {
    await answer("");
    return promptAccountInput(env, chatId);
  }

  if (cb.data === ACCOUNT_REMOVE_OPEN) {
    await answer("");
    const user = (await loadUser(env, chatId)) || userDefaults();
    if (!user.sources?.length) {
      const view = await accountSettingsView(env, chatId);
      return reply(env, chatId, view.text, { reply_markup: view.reply_markup });
    }
    user.account_removal_choices = [];
    await saveUser(env, chatId, user);
    const view = accountRemovalView(user);
    return reply(env, chatId, view.text, { reply_markup: view.reply_markup });
  }

  if (cb.data.startsWith(ACCOUNT_REMOVE_PICK)) {
    await answer("");
    const user = await loadUser(env, chatId);
    const index = Number(cb.data.slice(ACCOUNT_REMOVE_PICK.length));
    const source = user?.sources?.[index];
    if (!source) return;
    const selected = new Set(user.account_removal_choices || []);
    if (selected.has(source)) selected.delete(source);
    else selected.add(source);
    user.account_removal_choices = [...selected];
    await saveUser(env, chatId, user);
    const view = accountRemovalView(user);
    return tg(env, "editMessageText", {
      chat_id: chatId, message_id: controlId, text: view.text,
      parse_mode: "HTML", reply_markup: view.reply_markup,
      link_preview_options: { is_disabled: true },
    });
  }

  if (cb.data === ACCOUNT_REMOVE_DONE) {
    await answer("");
    const user = await loadUser(env, chatId);
    if (!user) return;
    const selected = new Set(user.account_removal_choices || []);
    user.sources = (user.sources || []).filter((source) => !selected.has(source));
    if (user.free_active_sources) {
      user.free_active_sources = user.free_active_sources.filter(
        (source) => !selected.has(source));
    }
    for (const source of selected) clearAccountHealth(user, source);
    if (selected.has(user.account_replacement?.old_handle)) delete user.account_replacement;
    delete user.account_removal_choices;
    await saveUser(env, chatId, user);
    const view = await accountSettingsView(env, chatId);
    const result = selected.size
      ? `✅ Removed ${selected.size} Watched account${selected.size === 1 ? "" : "s"}.\n\n`
      : "Nothing was removed.\n\n";
    return tg(env, "editMessageText", {
      chat_id: chatId, message_id: controlId, text: result + view.text,
      parse_mode: "HTML", reply_markup: view.reply_markup,
      link_preview_options: { is_disabled: true },
    });
  }

  if (cb.data === CHANNEL_CONNECT) {
    await answer("");
    return promptChannelInput(env, chatId);
  }

  if (cb.data === CHANNEL_DISCONNECT) {
    await answer("");
    const user = (await loadUser(env, chatId)) || userDefaults();
    user.channel = null;
    delete user.channel_verified;
    delete user.channel_candidate;
    delete user.settings_input;
    await saveUser(env, chatId, user);
    const view = channelSettingsView(user);
    return tg(env, "editMessageText", {
      chat_id: chatId, message_id: controlId,
      text: "✅ Publishing channel disconnected.\n\n" + view.text,
      parse_mode: "HTML", reply_markup: view.reply_markup,
      link_preview_options: { is_disabled: true },
    });
  }

  if (cb.data.startsWith(LANGUAGE_PICK)) {
    await answer("");
    const language = cb.data.slice(LANGUAGE_PICK.length);
    if (!["en", "uk", "ru"].includes(language)) return;
    const user = (await loadUser(env, chatId)) || userDefaults();
    user.language = language;
    await saveUser(env, chatId, user);
    const view = languageSettingsView(user);
    return tg(env, "editMessageText", {
      chat_id: chatId, message_id: controlId,
      text: "✅ Post language updated.\n\n" + view.text,
      parse_mode: "HTML", reply_markup: view.reply_markup,
      link_preview_options: { is_disabled: true },
    });
  }

  if (cb.data.startsWith(LIMIT_PICK)) {
    await answer("");
    const limit = Number(cb.data.slice(LIMIT_PICK.length));
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) return;
    const user = (await loadUser(env, chatId)) || userDefaults();
    user.limit = limit;
    await saveUser(env, chatId, user);
    const view = limitSettingsView(user);
    return tg(env, "editMessageText", {
      chat_id: chatId, message_id: controlId,
      text: `✅ Up to ${limit} posts will appear in each Digest.\n\n` + view.text,
      parse_mode: "HTML", reply_markup: view.reply_markup,
      link_preview_options: { is_disabled: true },
    });
  }

  if (cb.data === STYLE_CUSTOM) {
    await answer("");
    const user = (await loadUser(env, chatId)) || userDefaults();
    user.settings_input = "style";
    await saveUser(env, chatId, user);
    return reply(env, chatId,
      "Describe how captions should be written. Your next message will become the custom style.");
  }

  if (cb.data === STYLE_DEFAULT) {
    await answer("");
    const user = (await loadUser(env, chatId)) || userDefaults();
    user.style = null;
    delete user.settings_input;
    await saveUser(env, chatId, user);
    const view = styleSettingsView(user);
    return tg(env, "editMessageText", {
      chat_id: chatId, message_id: controlId,
      text: "✅ Default caption style restored.\n\n" + view.text,
      parse_mode: "HTML", reply_markup: view.reply_markup,
      link_preview_options: { is_disabled: true },
    });
  }

  if (cb.data === SETUP_ADD_ACCOUNT) {
    const user = (await loadUser(env, chatId)) || userDefaults();
    updateSetup(user, { addingAccount: true });
    await saveUser(env, chatId, user);
    await reply(env, chatId,
      "Send one more @handle, bare handle, or X profile URL.");
    return answer("");
  }

  if (cb.data === SETUP_TIMEZONE) {
    await answer("");
    const user = (await loadUser(env, chatId)) || userDefaults();
    return showTimezoneStep(env, chatId, user);
  }

  if (cb.data.startsWith(TIMEZONE_PICK)) {
    await answer("");
    const user = await loadUser(env, chatId);
    const index = Number(cb.data.slice(TIMEZONE_PICK.length));
    const choice = user?.setup?.timezone_choices?.[index];
    if (!choice) {
      return reply(env, chatId,
        "That timezone choice expired. Send the city again.");
    }
    user.setup.timezone_candidate = choice.zone;
    user.setup.choosing_timezone = false;
    delete user.setup.timezone_choices;
    updateSetup(user, { currentStep: "timezone" });
    await saveUser(env, chatId, user);
    return reply(env, chatId, timezoneConfirmationText(choice.zone, isActivated(user)),
      { reply_markup: timezoneConfirmationKeyboard() });
  }

  if (cb.data === TIMEZONE_CONFIRM) {
    await answer("");
    return confirmTimezone(env, chatId);
  }

  if (cb.data === TIMEZONE_RETRY) {
    await answer("");
    const user = (await loadUser(env, chatId)) || userDefaults();
    updateSetup(user, { currentStep: "timezone" });
    user.setup.choosing_timezone = true;
    delete user.setup.timezone_candidate;
    delete user.setup.timezone_choices;
    await saveUser(env, chatId, user);
    return reply(env, chatId,
      "Send a city such as Kyiv or an IANA timezone such as Europe/Kyiv.");
  }

  if (cb.data.startsWith(DIGEST_TIME_PICK)) {
    await answer("");
    const hour = Number(cb.data.slice(DIGEST_TIME_PICK.length));
    const user = await loadUser(env, chatId);
    if (!user || !Number.isInteger(hour) || hour < 0 || hour > 23) return;
    const plan = await resolvePlan(env, chatId, user);
    const selected = new Set(selectedDigestTimes(user));
    if (plan.tier === "free") {
      selected.clear();
      selected.add(hour);
    } else if (selected.has(hour)) selected.delete(hour);
    else if (selected.size < plan.limits.hours) selected.add(hour);
    else {
      return reply(env, chatId,
        `Your Pro plan includes up to ${plan.limits.hours} active daily Digest times.`);
    }
    updateSetup(user, { currentStep: "digest_time" });
    user.setup.digest_time_choices = [...selected].sort((a, b) => a - b);
    await saveUser(env, chatId, user);
    const view = digestTimeView(user, plan);
    return tg(env, "editMessageText", {
      chat_id: chatId, message_id: controlId, text: view.text,
      parse_mode: "HTML", reply_markup: view.reply_markup,
      link_preview_options: { is_disabled: true },
    });
  }

  if (cb.data === DIGEST_TIME_DONE) {
    await answer("");
    const user = await loadUser(env, chatId);
    const hours = selectedDigestTimes(user);
    if (!hours.length) {
      return reply(env, chatId, "Select at least one Digest time before tapping Done.");
    }
    await tg(env, "editMessageReplyMarkup", {
      chat_id: chatId, message_id: controlId,
      reply_markup: { inline_keyboard: [] },
    });
    return activateWithDigestTimes(env, chatId, hours, cb.from);
  }

  if (cb.data === SETUP_CONNECT_CHANNEL) {
    await answer("");
    const user = await loadUser(env, chatId);
    if (user) {
      user.setup.reminder_consumed = true;
      user.setup.channel_choice = "connect";
      await saveUser(env, chatId, user);
    }
    return promptChannelInput(env, chatId);
  }

  if (cb.data === SETUP_SKIP_CHANNEL) {
    await answer("");
    const user = await loadUser(env, chatId);
    if (user) {
      user.setup.reminder_consumed = true;
      user.setup.channel_choice = "not_now";
      user.setup.channel_skipped_at = new Date(Date.now()).toISOString();
      await saveUser(env, chatId, user);
    }
    return reply(env, chatId,
      "✅ Setup complete. Private Previews will arrive here; connect a Publishing " +
      "channel later from Settings or with /channel.");
  }

  if (cb.data === CHANNEL_RETRY) {
    await answer("");
    const candidate = (await loadUser(env, chatId))?.channel_candidate;
    if (!candidate) {
      return reply(env, chatId,
        "That channel setup expired. Open /channel and try again.");
    }
    return verifyPublishingChannel(env, chatId, candidate);
  }

  if (cb.data === CHANNEL_NOT_NOW) {
    await answer("");
    const user = await loadUser(env, chatId);
    const intent = user?.publishing_intent;
    if (!intent) return;
    delete user.publishing_intent;
    await saveUser(env, chatId, user);
    await tg(env, "editMessageReplyMarkup", {
      chat_id: chatId, message_id: intent.control,
      reply_markup: intent.controls || controlKeyboard(intent.ids),
    });
    return reply(env, chatId,
      "Not published. The Preview is still available with its existing controls.");
  }

  if (cb.data === CHANNEL_PUBLISH) {
    await answer("");
    const user = await loadUser(env, chatId);
    const intent = user?.publishing_intent;
    if (!intent || !user.channel) {
      return reply(env, chatId,
        "That publishing confirmation expired. Use ✅ Post on the Preview again.");
    }
    if (!await publishPreview(env, chatId, intent.control, intent.ids, user)) return;
    delete user.publishing_intent;
    await saveUser(env, chatId, user);
    return;
  }

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

  // ⏸/▶️ pause toggle from /settings: flip the user's `paused` flag and
  // re-render the settings message in place (button label + status line).
  // A paused user is skipped by the digest before any fetch (pipeline side).
  if (cb.data === "pt") {
    let paused;
    try {
      const user = (await loadUser(env, chatId)) || userDefaults();
      user.paused = !user.paused;
      paused = user.paused;
      await saveUser(env, chatId, user);
    } catch (err) {
      console.log("pause toggle failed:", err);
      return answer("Storage hiccup — try again.", true);
    }
    // The flag is already saved; a failed re-render shouldn't leave the
    // button spinning, so guard the edit and still answer the callback.
    try {
      const view = await settingsView(env, chatId);
      await tg(env, "editMessageText", {
        chat_id: chatId, message_id: controlId, text: view.text,
        parse_mode: "HTML", link_preview_options: { is_disabled: true },
        reply_markup: view.reply_markup,
      });
    } catch (err) {
      console.log("settings re-render failed:", err);
    }
    return answer(paused ? "Digests paused" : "Digests resumed");
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
    if (!user?.channel) return answer("Open /channel and connect a channel first.", true);
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
    const idsStr = cb.data.slice(2);
    const ids = idsStr.split(",").map(Number).sort((a, b) => a - b);
    const user = await loadUser(env, chatId);
    if (!user?.channel || user.channel_verified?.id !== user.channel) {
      await answer("");
      const entry = (await loadPending(env, chatId))?.[String(ids[0])];
      if (!entry) {
        return reply(env, chatId,
          "Preview data isn’t synced yet — tap ✅ Post again in a moment.");
      }
      const pendingUser = user || userDefaults();
      pendingUser.publishing_intent = {
        ids: idsStr, control: controlId,
        controls: cb.message.reply_markup || controlKeyboard(idsStr),
      };
      await saveUser(env, chatId, pendingUser);
      if (user?.channel) {
        return verifyPublishingChannel(env, chatId,
          { id: user.channel, title: String(user.channel) });
      }
      return reply(env, chatId,
        "This exact Preview is saved. Add me to your Publishing channel as an " +
        "administrator with <b>Post Messages</b> enabled, then open /channel and " +
        "follow the prompt. For a private channel, forward me a message from it.");
    }

    await answer("");

    await publishPreview(env, chatId, controlId, idsStr, user);
    return;
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
        await recordFirstPublish(env, job.chat, user);
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
    <li>Open <code>/add</code>, then send each X account when prompted</li>
    <li>Open <code>/schedule</code> and choose your Digest times</li>
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
