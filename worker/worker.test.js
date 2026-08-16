import assert from "node:assert/strict";
import test from "node:test";

import worker from "./worker.js";

const DAY = 86400000;

function createHarness({ users = {}, whitelist = [], promo = [], githubStatus = 204 } = {}) {
  const values = new Map();
  const sets = new Map([
    ["uids", new Set(Object.keys(users))],
    ["whitelist", new Set(whitelist.map(String))],
    ["promo", new Set(promo.map(String))],
  ]);
  for (const [id, user] of Object.entries(users)) {
    values.set(`user:${id}`, JSON.stringify(user));
  }
  const telegram = [];
  const github = [];
  let messageId = 1;

  const redis = (cmd) => {
    const [name, key, ...args] = cmd;
    if (name === "GET") return values.get(key) ?? null;
    if (name === "SET") {
      values.set(key, args[0]);
      return "OK";
    }
    if (name === "SADD") {
      const set = sets.get(key) || new Set();
      sets.set(key, set);
      let added = 0;
      for (const value of args) {
        if (!set.has(String(value))) added++;
        set.add(String(value));
      }
      return added;
    }
    if (name === "SREM") {
      const set = sets.get(key) || new Set();
      let removed = 0;
      for (const value of args) removed += set.delete(String(value)) ? 1 : 0;
      return removed;
    }
    if (name === "SISMEMBER") {
      return sets.get(key)?.has(String(args[0])) ? 1 : 0;
    }
    if (name === "SCARD") return sets.get(key)?.size || 0;
    if (name === "SMEMBERS") return [...(sets.get(key) || [])];
    if (name === "MGET") return args.map((item) => values.get(item) ?? null);
    throw new Error(`Unsupported Redis command: ${name}`);
  };

  const fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === "https://redis.test") {
      const result = redis(JSON.parse(options.body));
      return Response.json({ result });
    }
    if (target.startsWith("https://api.telegram.org/")) {
      const method = target.split("/").pop();
      const params = JSON.parse(options.body);
      telegram.push({ method, params });
      const result = method === "createInvoiceLink"
        ? "https://invoice.test/pro" : { message_id: messageId++ };
      return Response.json({ ok: true, result });
    }
    if (target.startsWith("https://api.github.com/")) {
      github.push(JSON.parse(options.body));
      return new Response(null, { status: githubStatus });
    }
    throw new Error(`Unexpected request: ${target}`);
  };

  return {
    fetch,
    github,
    telegram,
    user(id) {
      const raw = values.get(`user:${id}`);
      return raw ? JSON.parse(raw) : null;
    },
  };
}

function env(overrides = {}) {
  return {
    BOT_TOKEN: "token",
    WEBHOOK_SECRET: "secret",
    UPSTASH_REDIS_REST_URL: "https://redis.test",
    UPSTASH_REDIS_REST_TOKEN: "redis-token",
    PRO_PRICE_STARS: "550",
    GH_TOKEN: "gh-token",
    GH_REPO: "owner/repo",
    ...overrides,
  };
}

async function sendUpdate(harness, update, overrides = {}) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    const response = await worker.fetch(new Request("https://bot.test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "secret",
      },
      body: JSON.stringify(update),
    }), env(overrides), {});
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function sendUpdateAt(harness, update, now, overrides = {}) {
  const previousNow = Date.now;
  Date.now = () => now;
  try {
    await sendUpdate(harness, update, overrides);
  } finally {
    Date.now = previousNow;
  }
}

function message(id, text, from = {}) {
  return {
    message: {
      chat: { id, type: "private" },
      from: { id, first_name: "Alice", ...from },
      text,
    },
  };
}

function accountValidation(id, handle, outcome) {
  return { account_validation: { chat_id: String(id), handle, outcome } };
}

function callback(id, data) {
  return {
    callback_query: {
      id: `callback-${id}`,
      data,
      message: { chat: { id }, message_id: 1 },
    },
  };
}

function sentTo(harness, id) {
  return harness.telegram
    .filter(({ method, params }) => method === "sendMessage" && params.chat_id === id)
    .map(({ params }) => params.text);
}

test("a promotional trial is granted before the first welcome", async () => {
  const harness = createHarness();
  await sendUpdate(harness, message(101, "/start"));

  const replies = sentTo(harness, 101);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /^⭐ <b>XGist Pro Trial · 30 days left<\/b>/);
  assert.match(replies[0], /25 watched accounts · 6 Digest times\/day/);
  assert.doesNotMatch(replies[0], /Alice/);
  assert.equal(harness.user(101).pro_source, "trial");
  assert.ok(Date.parse(harness.user(101).paid_until) > Date.now() + 29 * DAY);
});

test("free access keeps the existing limits and upgrade action", async () => {
  const promo = Array.from({ length: 50 }, (_, index) => `promo-${index}`);
  const harness = createHarness({
    promo,
    users: { 102: { sources: ["a", "b", "c", "d", "e"], hours: [9] } },
  });
  await sendUpdate(harness, message(102, "/start"));
  await sendUpdate(harness, message(102, "/add f"));
  await sendUpdate(harness, message(102, "/schedule 9,18"));
  await sendUpdate(harness, message(102, "/settings"));

  const replies = sentTo(harness, 102);
  assert.match(replies[0], /^🆓 <b>XGist Free<\/b>/);
  assert.match(replies[1], /includes 5 watched accounts/);
  assert.match(replies[2], /up to 1 digest time\(s\) per day/);
  assert.match(replies[3], /🆓 <b>XGist Free<\/b>/);
  assert.match(replies[3], /Upgrade with \/pro/);
});

test("help and setup hints treat the Publishing channel as optional", async () => {
  const promo = Array.from({ length: 50 }, (_, index) => `promo-${index}`);
  const harness = createHarness({ promo });
  await sendUpdate(harness, message(110, "/help"));

  const replies = sentTo(harness, 110);
  assert.match(replies[0], /Setup — 2 steps/);
  assert.match(replies[0], /Optional: \/channel @yourchannel/);
});

test("paid access is labeled honestly and keeps Pro limits", async () => {
  const paidUntil = new Date(Date.now() + 20 * DAY).toISOString();
  const harness = createHarness({
    users: { 103: { sources: [], hours: [9], pro_source: "paid", paid_until: paidUntil } },
  });
  await sendUpdate(harness, message(103, "/schedule 1,2,3,4,5,6"));
  await sendUpdate(harness, message(103, "/pro"));

  const replies = sentTo(harness, 103);
  assert.match(replies[0], /01:00, 02:00, 03:00, 04:00, 05:00, 06:00/);
  assert.match(replies[1], /^⭐ <b>XGist Pro<\/b>/);
  assert.match(replies[1], new RegExp(paidUntil.slice(0, 10)));
  assert.match(replies[1], /Telegram Settings → My Stars/);
  assert.match(replies[1], /review your Pro setup with \/settings/);
});

test("legacy promotional users retain a trial identity", async () => {
  const paidUntil = new Date(Date.now() + 5 * DAY).toISOString();
  const harness = createHarness({
    users: { 104: { sources: [], hours: [9], paid_until: paidUntil } },
    promo: [104],
  });
  await sendUpdate(harness, message(104, "/settings"));
  assert.match(sentTo(harness, 104)[0], /XGist Pro Trial · 5 days left/);
});

test("courtesy and administrator access have distinct identities and Pro limits", async () => {
  const courtesy = createHarness({
    users: { 105: { sources: [], hours: [9] } },
    whitelist: [105],
  });
  await sendUpdate(courtesy, message(105, "/start"));
  await sendUpdate(courtesy, message(105, "/pro"));
  assert.match(sentTo(courtesy, 105)[0], /25 watched accounts/);
  assert.match(sentTo(courtesy, 105)[1], /XGist Pro · Courtesy access/);

  const administrator = createHarness({ users: { 106: { sources: [], hours: [9] } } });
  await sendUpdate(administrator, message(106, "/schedule 1,2,3,4,5,6"),
    { ADMIN_ID: "106" });
  await sendUpdate(administrator, message(106, "/pro"), { ADMIN_ID: "106" });
  assert.match(sentTo(administrator, 106)[0], /01:00, 02:00, 03:00, 04:00, 05:00, 06:00/);
  assert.match(sentTo(administrator, 106)[1], /XGist Pro · Administrator/);
});

test("paid access changes to Free exactly at the expiry boundary", async () => {
  const now = Date.parse("2026-08-16T12:00:00.000Z");
  const atBoundary = createHarness({
    users: {
      107: {
        sources: [],
        hours: [9],
        pro_source: "paid",
        paid_until: new Date(now).toISOString(),
      },
    },
  });
  await sendUpdateAt(atBoundary, message(107, "/settings"), now);
  assert.match(sentTo(atBoundary, 107)[0], /XGist Free/);

  const justBefore = createHarness({
    users: {
      107: {
        sources: [],
        hours: [9],
        pro_source: "paid",
        paid_until: new Date(now + 1).toISOString(),
      },
    },
  });
  await sendUpdateAt(justBefore, message(107, "/settings"), now);
  assert.match(sentTo(justBefore, 107)[0], /XGist Pro<\/b>/);
});

test("successful payment replaces trial identity with paid Pro", async () => {
  const until = new Date(Date.now() + 31 * DAY);
  const harness = createHarness({
    users: {
      108: {
        sources: [],
        hours: [9],
        pro_source: "trial",
        paid_until: new Date(Date.now() + 2 * DAY).toISOString(),
      },
    },
    promo: [108],
  });
  await sendUpdate(harness, {
    message: {
      chat: { id: 108, type: "private" },
      from: { id: 108, first_name: "Alice" },
      successful_payment: {
        subscription_expiration_date: Math.floor(until.getTime() / 1000),
        total_amount: 550,
        is_recurring: true,
      },
    },
  });

  const user = harness.user(108);
  const reply = sentTo(harness, 108)[0];
  assert.equal(user.pro_source, "paid");
  assert.match(reply, /^⭐ <b>XGist Pro<\/b>/);
  assert.match(reply, /25 watched accounts and 6 Digest times\/day/);
  assert.match(reply, /review your Pro setup with \/settings/);
  assert.doesNotMatch(reply, /Alice/);
});

test("the Free upgrade offer preserves the configured price and renewal", async () => {
  const harness = createHarness({
    users: { 109: { sources: [], hours: [9] } },
    promo: Array.from({ length: 50 }, (_, index) => `used-${index}`),
  });
  await sendUpdate(harness, message(109, "/pro"));

  const invoice = harness.telegram.find(({ method }) => method === "createInvoiceLink");
  assert.equal(invoice.params.prices[0].amount, 550);
  assert.equal(invoice.params.subscription_period, 2592000);
  assert.match(sentTo(harness, 109)[0], /550 Stars \/ month/);
  assert.match(sentTo(harness, 109)[0], /Renews automatically/);
});

test("new and repeated start resume Watched account setup without losing progress", async () => {
  const harness = createHarness({
    promo: Array.from({ length: 50 }, (_, index) => `used-${index}`),
  });
  await sendUpdate(harness, message(201, "/start"));
  const startedAt = harness.user(201).setup.started_at;
  await sendUpdate(harness, message(201, "/start"));

  const replies = sentTo(harness, 201);
  assert.equal(replies.length, 2);
  assert.match(replies[0], /Guided setup · Step 1 of 3/);
  assert.match(replies[0], /5 watched accounts/);
  assert.match(replies[1], /Guided setup · Step 1 of 3/);
  assert.equal(harness.user(201).setup.started_at, startedAt);
  assert.equal(harness.user(201).setup.current_step, "account");

  const configured = createHarness({
    users: { 202: { sources: ["naval"], hours: [9], timezone: null } },
  });
  await sendUpdate(configured, message(202, "/start"));
  assert.equal(configured.user(202).setup.current_step, "timezone");
  assert.match(sentTo(configured, 202)[0], /Guided setup · Step 2 of 3/);
});

test("accepted handle forms dispatch canonical validation and save only after success", async () => {
  const cases = [
    [211, "@Naval"],
    [212, "NAVAL"],
    [213, "https://x.com/Naval"],
    [214, "https://mobile.twitter.com/@Naval/?ref=home"],
  ];
  for (const [id, input] of cases) {
    const harness = createHarness({
      promo: Array.from({ length: 50 }, (_, index) => `used-${index}`),
    });
    await sendUpdate(harness, message(id, `/add ${input}`));
    assert.deepEqual(harness.github[0].inputs, {
      account_handle: "naval", only_user: String(id),
    });
    assert.deepEqual(harness.user(id).sources, []);

    await sendUpdate(harness, accountValidation(id, "naval", "readable"));
    assert.deepEqual(harness.user(id).sources, ["naval"]);
    assert.equal(harness.user(id).setup.current_step, "timezone");
    const sent = harness.telegram.filter(({ method, params }) =>
      method === "sendMessage" && params.chat_id === id).at(-1);
    assert.match(sent.params.text, /verified and now watched/);
    assert.deepEqual(sent.params.reply_markup.inline_keyboard[0].map(({ text }) => text),
      ["➕ Add another", "🌍 Choose timezone"]);
  }
});

test("Guided setup rejects malformed input before validation", async () => {
  const harness = createHarness();
  await sendUpdate(harness, message(220, "/start"));
  await sendUpdate(harness, message(220, "/add https://x.com/naval/status/123"));

  assert.equal(harness.github.length, 0);
  assert.deepEqual(harness.user(220).sources, []);
  assert.match(sentTo(harness, 220).at(-1), /doesn’t look like an X profile/);
});

test("validation outcomes are distinct, recoverable, and never save an unreadable account", async () => {
  const outcomes = [
    ["nonexistent", /couldn’t find/],
    ["protected", /is protected/],
    ["unreadable", /exists, but its posts aren’t readable/],
    ["transient", /couldn’t verify.*right now/],
  ];
  let id = 230;
  for (const [outcome, expected] of outcomes) {
    const harness = createHarness();
    await sendUpdate(harness, message(id, "/add sample"));
    await sendUpdate(harness, accountValidation(id, "sample", outcome));

    assert.deepEqual(harness.user(id).sources, []);
    assert.equal(harness.user(id).setup.current_step, "account");
    assert.equal(harness.user(id).account_validation, undefined);
    assert.match(sentTo(harness, id).at(-1), expected);
    const sent = harness.telegram.filter(({ method, params }) =>
      method === "sendMessage" && params.chat_id === id).at(-1);
    assert.equal(sent.params.reply_markup.inline_keyboard[0][0].text,
      "Try another account");
    id++;
  }
});

test("duplicate accounts and plan limits do not dispatch validation", async () => {
  const promo = Array.from({ length: 50 }, (_, index) => `used-${index}`);
  const duplicate = createHarness({
    promo,
    users: { 240: { sources: ["naval"], hours: [9] } },
  });
  await sendUpdate(duplicate, message(240, "/add @NAVAL"));
  assert.equal(duplicate.github.length, 0);
  assert.match(sentTo(duplicate, 240)[0], /already in your Watched accounts/);

  const limited = createHarness({
    promo,
    users: { 241: { sources: ["a", "b", "c", "d", "e"], hours: [9] } },
  });
  await sendUpdate(limited, message(241, "/add sixth"));
  assert.equal(limited.github.length, 0);
  assert.match(sentTo(limited, 241)[0], /includes 5 watched accounts/);
});

test("plain setup input and the add command share validation progress", async () => {
  const plain = createHarness();
  await sendUpdate(plain, message(250, "/start"));
  await sendUpdate(plain, message(250, "@Naval"));

  const command = createHarness();
  await sendUpdate(command, message(251, "/add @Naval"));

  assert.equal(plain.user(250).account_validation.handle, "naval");
  assert.equal(command.user(251).account_validation.handle, "naval");
  assert.equal(plain.user(250).setup.adding_account, true);
  assert.equal(command.user(251).setup.adding_account, true);
});

test("successful add actions continue the same Guided setup", async () => {
  const harness = createHarness({
    users: {
      260: {
        sources: ["naval"], hours: [9],
        setup: { current_step: "timezone", adding_account: false },
      },
    },
  });
  await sendUpdate(harness, callback(260, "setup:add-account"));
  assert.equal(harness.user(260).setup.adding_account, true);
  assert.match(sentTo(harness, 260).at(-1), /Send one more/);

  await sendUpdate(harness, message(260, "pmarca"));
  assert.equal(harness.user(260).account_validation.handle, "pmarca");
  await sendUpdate(harness, callback(260, "setup:timezone"));
  assert.match(sentTo(harness, 260).at(-1), /Guided setup · Step 2 of 3/);
});
