import assert from "node:assert/strict";
import test from "node:test";

import worker from "./worker.js";

const DAY = 86400000;

function createHarness({ users = {}, whitelist = [], promo = [] } = {}) {
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
    throw new Error(`Unexpected request: ${target}`);
  };

  return {
    fetch,
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
  const harness = createHarness({ promo });
  await sendUpdate(harness, message(102, "/start"));
  await sendUpdate(harness, message(102, "/add a b c d e f"));
  await sendUpdate(harness, message(102, "/schedule 9,18"));
  await sendUpdate(harness, message(102, "/settings"));

  const replies = sentTo(harness, 102);
  assert.match(replies[0], /^🆓 <b>XGist Free<\/b>/);
  assert.match(replies[1], /up to 5 accounts/);
  assert.match(replies[2], /up to 1 digest time\(s\) per day/);
  assert.match(replies[3], /🆓 <b>XGist Free<\/b>/);
  assert.match(replies[3], /Upgrade with \/pro/);
});

test("help and setup hints treat the Publishing channel as optional", async () => {
  const promo = Array.from({ length: 50 }, (_, index) => `promo-${index}`);
  const harness = createHarness({ promo });
  await sendUpdate(harness, message(110, "/help"));
  await sendUpdate(harness, message(110, "/add naval"));

  const replies = sentTo(harness, 110);
  assert.match(replies[0], /Setup — 2 steps/);
  assert.match(replies[0], /Optional: \/channel @yourchannel/);
  assert.match(replies[1], /Now watching/);
  assert.doesNotMatch(replies[1], /channel/);
  assert.doesNotMatch(replies[1], /Digests won't start/);
});

test("paid access is labeled honestly and keeps Pro limits", async () => {
  const paidUntil = new Date(Date.now() + 20 * DAY).toISOString();
  const harness = createHarness({
    users: { 103: { sources: [], hours: [9], pro_source: "paid", paid_until: paidUntil } },
  });
  await sendUpdate(harness, message(103, "/add a b c d e f"));
  await sendUpdate(harness, message(103, "/schedule 1,2,3,4,5,6"));
  await sendUpdate(harness, message(103, "/pro"));

  const replies = sentTo(harness, 103);
  assert.match(replies[0], /Now watching/);
  assert.match(replies[1], /01:00, 02:00, 03:00, 04:00, 05:00, 06:00/);
  assert.match(replies[2], /^⭐ <b>XGist Pro<\/b>/);
  assert.match(replies[2], new RegExp(paidUntil.slice(0, 10)));
  assert.match(replies[2], /Telegram Settings → My Stars/);
  assert.match(replies[2], /review your Pro setup with \/settings/);
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
  await sendUpdate(courtesy, message(105, "/add a b c d e f"));
  await sendUpdate(courtesy, message(105, "/pro"));
  assert.match(sentTo(courtesy, 105)[0], /Now watching/);
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
