import assert from "node:assert/strict";
import test from "node:test";

import worker from "./worker.js";

const DAY = 86400000;

function createHarness({
  users = {}, states = {}, whitelist = [], promo = [], githubStatus = 204,
  telegramResults = {}, schedules = {},
} = {}) {
  const values = new Map();
  const lists = new Map();
  const hashes = new Map([["sched", new Map(Object.entries(schedules))]]);
  const sets = new Map([
    ["uids", new Set(Object.keys(users))],
    ["whitelist", new Set(whitelist.map(String))],
    ["promo", new Set(promo.map(String))],
  ]);
  for (const [id, user] of Object.entries(users)) {
    values.set(`user:${id}`, JSON.stringify(user));
  }
  for (const [id, state] of Object.entries(states)) {
    values.set(`state:${id}`, JSON.stringify(state));
  }
  const telegram = [];
  const github = [];
  const telegramCounts = new Map();
  let messageId = 1;

  const redis = (cmd) => {
    const [name, key, ...args] = cmd;
    if (name === "GET") return values.get(key) ?? null;
    if (name === "SET") {
      values.set(key, args[0]);
      return "OK";
    }
    if (name === "INCR") {
      const value = Number(values.get(key) || 0) + 1;
      values.set(key, String(value));
      return value;
    }
    if (name === "DECR") {
      const value = Number(values.get(key) || 0) - 1;
      values.set(key, String(value));
      return value;
    }
    if (name === "EXPIRE") return values.has(key) ? 1 : 0;
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
    if (name === "MGET") return [key, ...args].map((item) => values.get(item) ?? null);
    if (name === "HGETALL") {
      return [...(hashes.get(key) || new Map()).entries()].flat();
    }
    if (name === "HDEL") {
      return (hashes.get(key) || new Map()).delete(String(args[0])) ? 1 : 0;
    }
    if (name === "RPUSH") {
      const list = lists.get(key) || [];
      list.push(...args);
      lists.set(key, list);
      return list.length;
    }
    if (name === "LTRIM") {
      const list = lists.get(key) || [];
      const start = Number(args[0]);
      const stop = Number(args[1]);
      const from = start < 0 ? Math.max(list.length + start, 0) : start;
      const to = stop < 0 ? list.length + stop + 1 : stop + 1;
      lists.set(key, list.slice(from, to));
      return "OK";
    }
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
      const call = telegramCounts.get(method) || 0;
      telegramCounts.set(method, call + 1);
      const configured = telegramResults[method];
      const response = typeof configured === "function"
        ? configured(params, call)
        : Array.isArray(configured) ? configured[Math.min(call, configured.length - 1)]
          : configured;
      if (response) return Response.json(response);
      if (method === "getMe") return Response.json({ ok: true, result: { id: 999 } });
      if (method === "getChatMember") {
        return Response.json({
          ok: true,
          result: { status: "administrator", can_post_messages: true },
        });
      }
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
    state(id) {
      const raw = values.get(`state:${id}`);
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

async function sendScheduledAt(harness, now, overrides = {}) {
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  globalThis.fetch = harness.fetch;
  Date.now = () => now;
  let pending;
  try {
    await worker.scheduled({}, env(overrides), {
      waitUntil(value) {
        pending = value;
      },
    });
    await pending;
  } finally {
    globalThis.fetch = previousFetch;
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

function callback(id, data, from = {}) {
  return {
    callback_query: {
      id: `callback-${id}`,
      data,
      from: { id, first_name: "Alice", ...from },
      message: { chat: { id }, message_id: 1 },
    },
  };
}

function readyForDigestTime(overrides = {}) {
  return {
    sources: ["naval"], hours: [9], timezone: "Europe/Kyiv",
    setup: {
      current_step: "digest_time",
      timezone_confirmed_at: "2026-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

function activatedUser(overrides = {}) {
  return {
    channel: "@briefings",
    sources: ["naval", "pmarca"],
    hours: [9, 18],
    timezone: "Europe/Kyiv",
    language: "en",
    setup: {
      current_step: "complete",
      timezone_confirmed_at: "2026-01-01T00:00:00.000Z",
      digest_time_confirmed_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T00:00:00.000Z",
    },
    ...overrides,
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

test("help opens concise topics and every topic answers its callback", async () => {
  const promo = Array.from({ length: 50 }, (_, index) => `promo-${index}`);
  const harness = createHarness({ promo });
  await sendUpdate(harness, message(110, "/help"));

  const menu = harness.telegram.find(({ method }) => method === "sendMessage");
  assert.match(menu.params.text, /Choose a topic/);
  assert.deepEqual(menu.params.reply_markup.inline_keyboard.flat().map(({ text }) => text), [
    "Setup", "Accounts and briefings", "Publishing", "Preview editing", "Free versus Pro",
  ]);

  const topics = [
    ["setup", /Guided setup/],
    ["briefings", /Watched accounts and briefings/],
    ["publishing", /Publishing channel is optional/],
    ["preview", /Preview editing/],
    ["plans", /Free versus Pro/],
  ];
  for (const [topic, expected] of topics) {
    const before = harness.telegram.length;
    await sendUpdate(harness, callback(110, `help:topic:${topic}`));
    assert.equal(harness.telegram[before].method, "answerCallbackQuery");
    assert.match(sentTo(harness, 110).at(-1), expected);
  }
});

test("activated start shows plan-aware configured value while unactivated start resumes setup", async () => {
  const promo = Array.from({ length: 50 }, (_, index) => `promo-${index}`);
  const free = createHarness({ users: { 120: activatedUser() }, promo });
  await sendUpdate(free, message(120, "/start"));

  const freeHome = sentTo(free, 120)[0];
  assert.match(freeHome, /^🏠 <b>Alice, your daily briefings<\/b>/);
  assert.match(freeHome, /2 configured · 09:00, 18:00/);
  assert.match(freeHome, /2 Watched accounts/);
  assert.match(freeHome, /Timezone: Europe\/Kyiv/);
  assert.match(freeHome, /Publishing channel: @briefings/);
  assert.match(freeHome, /XGist Free/);
  assert.doesNotMatch(freeHome, /Maximum|5 Watched accounts|Guided setup/);

  const paidUntil = new Date(Date.now() + DAY).toISOString();
  const pro = createHarness({
    users: { 121: activatedUser({ pro_source: "paid", paid_until: paidUntil }) },
  });
  await sendUpdate(pro, message(121, "/start", { first_name: "Marta" }));
  const proHome = sentTo(pro, 121)[0];
  assert.match(proHome, /^🏠 <b>Marta, your daily briefings<\/b>/);
  assert.match(proHome, /XGist Pro/);
  assert.doesNotMatch(proHome, /25 Watched accounts|6 Digest times|Maximum/);

  const unactivated = createHarness({ promo });
  await sendUpdate(unactivated, message(122, "/start"));
  assert.match(sentTo(unactivated, 122)[0], /Guided setup · Step 1 of 3/);
  assert.doesNotMatch(sentTo(unactivated, 122)[0], /Alice/);

  const legacyConfig = {
    channel: null, sources: ["naval"], hours: [8], timezone: "Europe/London",
  };
  const legacy = createHarness({ users: { 125: legacyConfig }, promo });
  await sendUpdate(legacy, message(125, "/start"));
  assert.match(sentTo(legacy, 125)[0], /Alice, your daily briefings/);
  assert.match(sentTo(legacy, 125)[0], /08:00/);
  assert.equal(legacy.user(125).setup, undefined);
  assert.deepEqual(legacy.user(125).sources, legacyConfig.sources);
  assert.deepEqual(legacy.user(125).hours, legacyConfig.hours);
  assert.equal(legacy.user(125).timezone, legacyConfig.timezone);
});

test("setup shows saved configuration and safe edit actions without resetting it", async () => {
  const original = activatedUser({ language: "uk", style: "quiet", limit: 3 });
  const harness = createHarness({ users: { 123: original } });
  await sendUpdate(harness, message(123, "/setup"));

  const setup = harness.telegram.find(({ method }) => method === "sendMessage");
  assert.match(setup.params.text, /Current setup/);
  assert.match(setup.params.text, /Watched accounts:.*naval.*pmarca/);
  assert.match(setup.params.text, /Timezone: Europe\/Kyiv/);
  assert.match(setup.params.text, /Digest times: 09:00, 18:00/);
  assert.match(setup.params.text, /Publishing channel: @briefings/);
  assert.match(setup.params.text, /Maximum: 5 Watched accounts · 1 Digest time\/day/);
  assert.deepEqual(setup.params.reply_markup.inline_keyboard.flat().map(({ text }) => text), [
    "Edit accounts", "Edit timezone", "Edit Digest times", "Edit channel",
  ]);
  assert.deepEqual(harness.user(123), original);

  for (const action of ["accounts", "timezone", "times", "channel"]) {
    const before = harness.telegram.length;
    await sendUpdate(harness, callback(123, `setup:edit:${action}`));
    assert.equal(harness.telegram[before].method, "answerCallbackQuery");
    assert.deepEqual(harness.user(123), original);
  }
  assert.equal(harness.user(123).language, "uk");
  assert.match(sentTo(harness, 123).at(-1), /Publishing channel/);
});

test("setup reminders honor the 24-hour boundary and move with new activity", async () => {
  const started = Date.parse("2026-08-01T12:00:00.000Z");
  const promo = Array.from({ length: 50 }, (_, index) => `used-${index}`);
  const harness = createHarness({
    users: {
      130: {
        setup_reminder_eligible: true,
        sources: [], hours: [9], timezone: null,
        setup: {
          started_at: new Date(started).toISOString(),
          last_activity_at: new Date(started).toISOString(),
          current_step: "account",
          reminder_consumed: false,
        },
      },
    },
    promo,
  });

  await sendScheduledAt(harness, started + DAY - 1);
  assert.equal(sentTo(harness, 130).length, 0);

  await sendUpdateAt(harness, message(130, "/start"), started + DAY - 1);
  harness.telegram.length = 0;
  await sendScheduledAt(harness, started + DAY);
  assert.equal(sentTo(harness, 130).length, 0);

  const resetAt = Date.parse(harness.user(130).setup.last_activity_at);
  await sendScheduledAt(harness, resetAt + DAY);
  assert.equal(sentTo(harness, 130).length, 1);
  assert.match(sentTo(harness, 130)[0], /XGist Free setup reminder/);
  assert.match(sentTo(harness, 130)[0], /Guided setup · Step 1 of 3/);
  assert.equal(harness.user(130).setup.abandonment_step, "account");
  assert.ok(harness.user(130).setup.reminder_delivered_at);
});

test("setup reminders resume the exact missing step with plan-aware controls", async () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  const stale = new Date(now - DAY).toISOString();
  const paidUntil = new Date(now + 10 * DAY).toISOString();
  const harness = createHarness({
    users: {
      131: {
        setup_reminder_eligible: true, sources: [], hours: [9], timezone: null,
        setup: { started_at: stale, last_activity_at: stale, reminder_consumed: false },
      },
      132: {
        setup_reminder_eligible: true, sources: ["naval"], hours: [9], timezone: null,
        setup: { started_at: stale, last_activity_at: stale, reminder_consumed: false },
      },
      133: {
        setup_reminder_eligible: true, sources: ["naval"], hours: [9],
        timezone: "Europe/Kyiv", paid_until: paidUntil, pro_source: "paid",
        setup: {
          started_at: stale, last_activity_at: stale, reminder_consumed: false,
          timezone_confirmed_at: stale,
        },
      },
    },
  });

  await sendScheduledAt(harness, now);

  assert.match(sentTo(harness, 131)[0], /XGist Free setup reminder/);
  assert.match(sentTo(harness, 131)[0], /Step 1 of 3/);
  assert.match(sentTo(harness, 132)[0], /Step 2 of 3/);
  assert.match(sentTo(harness, 133)[0], /XGist Pro setup reminder/);
  assert.match(sentTo(harness, 133)[0], /Step 3 of 3/);
  const digestReminder = harness.telegram.find(({ method, params }) =>
    method === "sendMessage" && params.chat_id === 133);
  assert.equal(digestReminder.params.reply_markup.inline_keyboard.flat().at(-1).text, "Done");
  assert.equal(harness.user(131).setup.abandonment_step, "account");
  assert.equal(harness.user(132).setup.abandonment_step, "timezone");
  assert.equal(harness.user(133).setup.abandonment_step, "digest_time");
});

test("a failed reminder is consumed once and later activity records recovery", async () => {
  const now = Date.parse("2026-08-05T12:00:00.000Z");
  const stale = new Date(now - DAY).toISOString();
  const harness = createHarness({
    users: {
      134: {
        setup_reminder_eligible: true, sources: [], hours: [9], timezone: null,
        setup: { started_at: stale, last_activity_at: stale, reminder_consumed: false },
      },
    },
    promo: Array.from({ length: 50 }, (_, index) => `used-${index}`),
    telegramResults: {
      sendMessage: { ok: false, description: "Forbidden: bot was blocked by the user" },
    },
  });

  await sendScheduledAt(harness, now);
  await sendScheduledAt(harness, now + DAY);
  assert.equal(harness.telegram.filter(({ method, params }) =>
    method === "sendMessage" && /setup reminder/.test(params.text)).length, 1);
  assert.equal(harness.user(134).setup.reminder_consumed, true);
  assert.equal(harness.user(134).setup.reminder_delivered_at, undefined);
  assert.ok(harness.user(134).setup.reminder_attempted_at);

  await sendUpdateAt(harness, message(134, "/start"), now + DAY + 1);
  assert.ok(harness.user(134).setup.reminder_recovered_at);
});

test("activated, optional-channel, and pre-release users never receive reminders", async () => {
  const now = Date.parse("2026-08-07T12:00:00.000Z");
  const stale = new Date(now - 2 * DAY).toISOString();
  const harness = createHarness({
    users: {
      135: activatedUser({ setup_reminder_eligible: true }),
      136: {
        setup_reminder_eligible: true, sources: ["naval"], hours: [9],
        timezone: "Europe/Kyiv",
        setup: {
          started_at: stale, last_activity_at: stale, reminder_consumed: true,
          current_step: "complete", completed_at: stale,
          timezone_confirmed_at: stale, digest_time_confirmed_at: stale,
          channel_choice: "not_now",
        },
      },
      137: {
        sources: [], hours: [9], timezone: null,
        setup: { started_at: stale, last_activity_at: stale, reminder_consumed: false },
      },
    },
  });

  await sendScheduledAt(harness, now);
  assert.equal(sentTo(harness, 135).length, 0);
  assert.equal(sentTo(harness, 136).length, 0);
  assert.equal(sentTo(harness, 137).length, 0);
});

test("registered and hidden power-user commands remain available", async () => {
  const harness = createHarness({ users: { 124: activatedUser() } });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    const response = await worker.fetch(
      new Request("https://bot.test/setup-commands?key=secret"), env(), {});
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = previousFetch;
  }
  const registered = harness.telegram.find(({ method }) => method === "setMyCommands")
    .params.commands.map(({ command }) => command);
  for (const command of [
    "start", "setup", "channel", "add", "schedule", "lang", "post_style", "list",
    "remove", "limit", "timezone", "settings", "pro", "feedback", "help",
  ]) {
    assert.ok(registered.includes(command), command);
  }

  await sendUpdate(harness, message(124, "/language uk"));
  await sendUpdate(harness, message(124, "/style concise"));
  await sendUpdate(harness, message(124, "/interests technology"));
  await sendUpdate(harness, message(124, "/times 7"));
  assert.equal(harness.user(124).language, "uk");
  assert.equal(harness.user(124).style, "concise");
  assert.equal(harness.user(124).interests, "technology");
  assert.deepEqual(harness.user(124).hours, [7]);
});

test("a pasted status link dispatches a thread Preview and enforces the Free quota", async () => {
  const harness = createHarness({
    users: { 111: { sources: [], hours: [9] } },
    promo: Array.from({ length: 50 }, (_, index) => `used-${index}`),
  });
  await sendUpdate(harness, message(111,
    "Please use https://mobile.twitter.com/Naval/status/12345?ref=home#post thanks"));
  await sendUpdate(harness, message(111, "https://www.x.com/naval/status/67890"));

  assert.deepEqual(harness.github[0].inputs, {
    thread_url: "https://mobile.twitter.com/Naval/status/12345",
    only_user: "111",
  });
  assert.equal(harness.github.length, 1);
  assert.match(sentTo(harness, 111)[0], /Fetching that thread/);
  assert.match(sentTo(harness, 111)[1], /thread limit \(1\/day\)/);
});

test("Pro and administrator thread quotas use their plan limits", async () => {
  const paidUntil = new Date(Date.now() + DAY).toISOString();
  const pro = createHarness({
    users: { 112: { sources: [], hours: [9], paid_until: paidUntil } },
  });
  for (let index = 0; index < 6; index++) {
    await sendUpdate(pro, message(112, `https://x.com/user/status/${10000 + index}`));
  }
  assert.equal(pro.github.length, 5);
  assert.match(sentTo(pro, 112).at(-1), /thread limit \(5\/day\)/);

  const admin = createHarness({ users: { 113: { sources: [], hours: [9] } } });
  for (let index = 0; index < 6; index++) {
    await sendUpdate(admin, message(113, `https://x.com/user/status/${20000 + index}`),
      { ADMIN_ID: "113" });
  }
  assert.equal(admin.github.length, 6);
  assert.equal(sentTo(admin, 113).every((text) => /Fetching that thread/.test(text)), true);
});

test("failed thread dispatches refund quota", async () => {
  const harness = createHarness({
    users: { 114: { sources: [], hours: [9] } },
    promo: Array.from({ length: 50 }, (_, index) => `used-${index}`),
    githubStatus: 500,
  });
  await sendUpdate(harness, message(114, "https://x.com/user/status/30001"));
  await sendUpdate(harness, message(114, "https://x.com/user/status/30002"));

  assert.equal(harness.github.length, 2);
  assert.equal(sentTo(harness, 114).every((text) => /HTTP 500/.test(text)), true);
});

test("a pasted status link during Edit is edit content and does not consume quota", async () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  const harness = createHarness({
    users: {
      116: {
        sources: [], hours: [9],
        editing: { ids: [40], control: 41, prompt: [], until: now + 60000 },
      },
    },
    states: {
      116: {
        pending: {
          40: { source: "naval", text: "Original", caption: "Original", media: [] },
        },
      },
    },
    promo: Array.from({ length: 50 }, (_, index) => `used-${index}`),
  });
  await sendUpdateAt(harness, message(116, "https://x.com/user/status/40001"), now);

  assert.equal(harness.github.length, 0);
  assert.equal(harness.user(116).editing, undefined);
  assert.match(harness.state(116).pending["1"].caption,
    /https:\/\/x\.com\/user\/status\/40001/);

  await sendUpdateAt(harness, message(116, "https://x.com/user/status/40002"), now);
  assert.equal(harness.github.length, 1);
  assert.match(sentTo(harness, 116).at(-1), /Fetching that thread/);
});

test("settings pause and resume preserve the rest of the user configuration", async () => {
  const original = {
    channel: "@news", sources: ["naval"], hours: [9, 18],
    timezone: "Europe/Kyiv", language: "uk", style: "concise", limit: 2,
  };
  const harness = createHarness({ users: { 115: original } });
  await sendUpdate(harness, message(115, "/settings"));

  const settings = harness.telegram.find(({ method }) => method === "sendMessage");
  assert.match(settings.params.text, /Digest: Active/);
  assert.equal(settings.params.reply_markup.inline_keyboard[0][0].text,
    "⏸ Pause digests");

  await sendUpdate(harness, callback(115, "pt"));
  assert.deepEqual(harness.user(115), { ...original, paused: true });
  const paused = harness.telegram.findLast(({ method }) => method === "editMessageText");
  assert.match(paused.params.text, /Digest: Paused/);
  assert.equal(paused.params.reply_markup.inline_keyboard[0][0].text,
    "▶️ Resume digests");

  await sendUpdate(harness, callback(115, "pt"));
  assert.deepEqual(harness.user(115), { ...original, paused: false });
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

test("city and IANA input resolve to a confirmation without saving early", async () => {
  const winter = Date.parse("2026-01-15T12:00:00.000Z");
  const city = createHarness({
    users: {
      301: {
        sources: ["naval"], hours: [9], timezone: null,
        setup: { current_step: "timezone" },
      },
    },
  });
  await sendUpdateAt(city, message(301, "Kyiv"), winter);

  assert.equal(city.user(301).timezone, null);
  assert.equal(city.user(301).setup.timezone_candidate, "Europe/Kyiv");
  assert.match(sentTo(city, 301)[0], /Timezone: <code>Europe\/Kyiv<\/code>/);
  assert.match(sentTo(city, 301)[0], /14:00/);

  const iana = createHarness({
    users: {
      302: {
        sources: ["naval"], hours: [9], timezone: null,
        setup: { current_step: "timezone" },
      },
    },
  });
  await sendUpdateAt(iana, message(302, "/timezone America/North_Dakota/Center"),
    winter);
  assert.equal(iana.user(302).setup.timezone_candidate,
    "America/North_Dakota/Center");
  assert.equal(iana.user(302).timezone, null);
});

test("ambiguous city input requires a disambiguation choice", async () => {
  const harness = createHarness({
    users: {
      310: {
        sources: ["naval"], hours: [9], timezone: null,
        setup: { current_step: "timezone" },
      },
    },
  });
  await sendUpdate(harness, message(310, "Springfield"));

  assert.equal(harness.user(310).timezone, null);
  assert.equal(harness.user(310).setup.timezone_choices.length, 2);
  const prompt = harness.telegram.find(({ method, params }) =>
    method === "sendMessage" && params.chat_id === 310);
  assert.match(prompt.params.text, /more than one match/);
  assert.deepEqual(prompt.params.reply_markup.inline_keyboard.map((row) => row[0].text),
    ["Springfield, Illinois", "Springfield, Massachusetts"]);

  await sendUpdate(harness, callback(310, "timezone:pick:1"));
  assert.equal(harness.user(310).setup.timezone_candidate, "America/New_York");
  assert.equal(harness.user(310).timezone, null);
  const methods = harness.telegram.slice(-2).map(({ method }) => method);
  assert.deepEqual(methods, ["answerCallbackQuery", "sendMessage"]);
});

test("only explicit confirmation completes the timezone prerequisite", async () => {
  const now = Date.parse("2026-06-15T12:00:00.000Z");
  const harness = createHarness({
    users: {
      320: {
        sources: ["naval"], hours: [9], timezone: null,
        setup: { current_step: "timezone" },
      },
    },
  });
  await sendUpdateAt(harness, message(320, "/timezone Europe/Kyiv"), now);
  assert.equal(harness.user(320).timezone, null);
  assert.equal(harness.user(320).setup.timezone_confirmed_at, undefined);
  assert.match(sentTo(harness, 320)[0], /15:00/);

  await sendUpdateAt(harness, callback(320, "timezone:confirm"), now);
  assert.equal(harness.user(320).timezone, "Europe/Kyiv");
  assert.equal(harness.user(320).setup.current_step, "digest_time");
  assert.equal(harness.user(320).setup.timezone_confirmed_at,
    "2026-06-15T12:00:00.000Z");
  assert.match(sentTo(harness, 320).at(-1), /Guided setup · Step 3 of 3/);

  const legacy = createHarness({
    users: {
      321: {
        sources: ["naval"], hours: [9], timezone: "Europe/London",
        setup: {
          current_step: "timezone", timezone_candidate: "Europe/Kyiv",
        },
      },
    },
  });
  await sendUpdateAt(legacy, callback(321, "timezone:confirm"), now);
  assert.equal(legacy.user(321).timezone, "Europe/Kyiv");
  assert.equal(legacy.user(321).setup.current_step, "digest_time");
  assert.match(sentTo(legacy, 321).at(-1), /Guided setup · Step 3 of 3/);

  await sendUpdateAt(harness, message(320, "/start"), now);
  assert.equal(harness.user(320).setup.current_step, "digest_time");
  assert.match(sentTo(harness, 320).at(-1), /Guided setup · Step 3 of 3/);
});

test("invalid timezone input stays recoverably on step 2", async () => {
  const harness = createHarness({
    users: {
      330: {
        sources: ["naval"], hours: [9], timezone: null,
        setup: { current_step: "timezone" },
      },
    },
  });
  await sendUpdate(harness, message(330, "/timezone Middle of nowhere"));

  assert.equal(harness.user(330).timezone, null);
  assert.equal(harness.user(330).setup.current_step, "timezone");
  assert.equal(harness.user(330).setup.choosing_timezone, true);
  assert.match(sentTo(harness, 330)[0], /couldn’t resolve/);
  assert.match(sentTo(harness, 330)[0], /Europe\/Kyiv/);
});

test("start resumes a pending timezone confirmation", async () => {
  const harness = createHarness({
    users: {
      340: {
        sources: ["naval"], hours: [9], timezone: null,
        setup: {
          current_step: "timezone", timezone_candidate: "Europe/London",
        },
      },
    },
  });
  await sendUpdate(harness, message(340, "/start"));

  assert.equal(harness.user(340).timezone, null);
  assert.equal(harness.user(340).setup.timezone_candidate, "Europe/London");
  assert.match(sentTo(harness, 340)[0], /Timezone: <code>Europe\/London<\/code>/);
  const sent = harness.telegram.find(({ method, params }) =>
    method === "sendMessage" && params.chat_id === 340);
  assert.equal(sent.params.reply_markup.inline_keyboard[0][0].callback_data,
    "timezone:confirm");
});

test("timezone changes preserve local Digest hours and share command progress", async () => {
  const harness = createHarness({
    users: {
      350: {
        sources: ["naval"], hours: [8, 18], timezone: "America/New_York",
        setup: {
          current_step: "complete", completed_at: "2026-01-01T00:00:00.000Z",
          timezone_confirmed_at: "2026-01-01T00:00:00.000Z",
        },
      },
    },
  });
  await sendUpdate(harness, message(350, "/timezone London"));
  assert.equal(harness.user(350).timezone, "America/New_York");
  assert.equal(harness.user(350).setup.current_step, "timezone");

  await sendUpdate(harness, callback(350, "timezone:confirm"));
  assert.equal(harness.user(350).timezone, "Europe/London");
  assert.equal(harness.user(350).setup.current_step, "complete");
  assert.equal(harness.user(350).setup.completed_at, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(harness.user(350).hours, [8, 18]);
  assert.match(sentTo(harness, 350).at(-1), /Digest times remain 08:00, 18:00/);
  assert.match(sentTo(harness, 350).at(-1), /local wall-clock time/);
});

test("direct timezone confirmation preserves the actual required setup step", async () => {
  const harness = createHarness({
    users: {
      360: {
        sources: [], hours: [9], timezone: null,
        setup: { current_step: "account" },
      },
    },
  });
  await sendUpdate(harness, message(360, "/timezone Kyiv"));
  await sendUpdate(harness, callback(360, "timezone:confirm"));

  assert.equal(harness.user(360).timezone, "Europe/Kyiv");
  assert.equal(harness.user(360).setup.current_step, "account");
  assert.match(sentTo(harness, 360).at(-1), /adding a Watched account/);

  await sendUpdate(harness, message(360, "/add naval"));
  await sendUpdate(harness, accountValidation(360, "naval", "readable"));
  assert.equal(harness.user(360).setup.current_step, "digest_time");
});

test("Free Guided setup shows all hours and activates on exactly one explicit choice", async () => {
  const harness = createHarness({
    users: { 401: readyForDigestTime() },
    promo: Array.from({ length: 50 }, (_, index) => `used-${index}`),
  });
  await sendUpdate(harness, message(401, "/start"));

  const prompt = harness.telegram.find(({ method, params }) =>
    method === "sendMessage" && params.chat_id === 401);
  assert.match(prompt.params.text, /Guided setup · Step 3 of 3/);
  assert.match(prompt.params.text, /Free plan includes exactly one/);
  assert.match(prompt.params.text, /within a few minutes after the selected hour/);
  assert.equal(prompt.params.reply_markup.inline_keyboard.length, 6);
  assert.ok(prompt.params.reply_markup.inline_keyboard.every((row) => row.length === 4));
  assert.equal(prompt.params.reply_markup.inline_keyboard.flat().length, 24);
  assert.ok(prompt.params.reply_markup.inline_keyboard.flat()
    .every(({ text }) => !text.startsWith("✓")));
  assert.equal(harness.user(401).setup.digest_time_confirmed_at, undefined);

  await sendUpdate(harness, callback(401, "digest-time:pick:14"));
  const user = harness.user(401);
  assert.deepEqual(user.hours, [14]);
  assert.ok(user.setup.digest_time_confirmed_at);
  assert.ok(user.setup.completed_at);
  assert.equal(user.setup.current_step, "complete");
  const completion = harness.telegram.filter(({ method, params }) =>
    method === "sendMessage" && params.chat_id === 401).at(-1);
  assert.match(completion.params.text, /Setup complete · XGist Free/);
  assert.match(completion.params.text, /Alice, your Digest is active at 14:00/);
  assert.deepEqual(completion.params.reply_markup.inline_keyboard[0]
    .map(({ text }) => text), ["Connect channel", "Not now"]);
  assert.deepEqual(harness.telegram.slice(-3).map(({ method }) => method),
    ["answerCallbackQuery", "editMessageReplyMarkup", "sendMessage"]);
});

test("every Pro source can select six distinct times, resume, and activate with Done", async () => {
  const future = new Date(Date.now() + 10 * DAY).toISOString();
  const cases = [
    {
      id: 410,
      user: { paid_until: future, pro_source: "paid" },
      expected: /Setup complete · XGist Pro<\/b>/,
    },
    {
      id: 411,
      user: { paid_until: future, pro_source: "trial" },
      expected: /Setup complete · XGist Pro Trial/,
    },
    {
      id: 412,
      user: {},
      harness: { whitelist: [412] },
      expected: /Setup complete · XGist Pro · Courtesy access/,
    },
    {
      id: 413,
      user: {},
      env: { ADMIN_ID: "413" },
      expected: /Setup complete · XGist Pro · Administrator/,
    },
  ];
  for (const item of cases) {
    const harness = createHarness({
      users: { [item.id]: readyForDigestTime(item.user) },
      ...(item.harness || {}),
    });
    await sendUpdate(harness, message(item.id, "/start"), item.env);
    for (const hour of [1, 5]) {
      await sendUpdate(harness, callback(item.id, `digest-time:pick:${hour}`), item.env);
    }
    await sendUpdate(harness, message(item.id, "/start"), item.env);
    const resumed = harness.telegram.filter(({ method, params }) =>
      method === "sendMessage" && params.chat_id === item.id).at(-1);
    const resumedLabels = resumed.params.reply_markup.inline_keyboard.flat()
      .map(({ text }) => text);
    assert.ok(resumedLabels.includes("✓ 01:00"));
    assert.ok(resumedLabels.includes("✓ 05:00"));
    assert.equal(resumedLabels.at(-1), "Done");

    for (const hour of [9, 13, 17, 21]) {
      await sendUpdate(harness, callback(item.id, `digest-time:pick:${hour}`), item.env);
    }
    await sendUpdate(harness, callback(item.id, "digest-time:pick:22"), item.env);
    assert.deepEqual(harness.user(item.id).setup.digest_time_choices,
      [1, 5, 9, 13, 17, 21]);
    assert.match(sentTo(harness, item.id).at(-1), /up to 6 active daily Digest times/);

    await sendUpdate(harness, callback(item.id, "digest-time:done"), item.env);
    const user = harness.user(item.id);
    assert.deepEqual(user.hours, [1, 5, 9, 13, 17, 21]);
    assert.ok(user.setup.completed_at);
    assert.match(sentTo(harness, item.id).at(-1), item.expected);
  }
});

test("schedule completes the same activation prerequisite when earlier steps are ready", async () => {
  const harness = createHarness({
    users: { 420: readyForDigestTime() },
    promo: Array.from({ length: 50 }, (_, index) => `used-${index}`),
  });
  await sendUpdate(harness, message(420, "/schedule 18"));

  assert.deepEqual(harness.user(420).hours, [18]);
  assert.ok(harness.user(420).setup.digest_time_confirmed_at);
  assert.ok(harness.user(420).setup.completed_at);
  assert.match(sentTo(harness, 420)[0], /Setup complete · XGist Free/);

  const completedAt = harness.user(420).setup.completed_at;
  await sendUpdate(harness, message(420, "/schedule 7"));
  assert.deepEqual(harness.user(420).hours, [7]);
  assert.equal(harness.user(420).setup.completed_at, completedAt);
  assert.match(sentTo(harness, 420).at(-1), /Digest times updated: 07:00/);
  assert.doesNotMatch(sentTo(harness, 420).at(-1), /Setup complete/);
});

test("skipping the optional Publishing channel is a successful terminal path", async () => {
  const harness = createHarness({
    users: { 430: readyForDigestTime() },
    promo: Array.from({ length: 50 }, (_, index) => `used-${index}`),
  });
  await sendUpdate(harness, message(430, "/schedule 8"));
  const completedAt = harness.user(430).setup.completed_at;
  await sendUpdate(harness, callback(430, "setup:skip-channel"));

  const user = harness.user(430);
  assert.equal(user.setup.completed_at, completedAt);
  assert.equal(user.setup.current_step, "complete");
  assert.equal(user.setup.reminder_consumed, true);
  assert.equal(user.setup.channel_choice, "not_now");
  assert.ok(user.setup.channel_skipped_at);
  assert.match(sentTo(harness, 430).at(-1), /Setup complete/);
  assert.match(sentTo(harness, 430).at(-1), /connect a Publishing channel later/);
  assert.deepEqual(harness.telegram.slice(-2).map(({ method }) => method),
    ["answerCallbackQuery", "sendMessage"]);
});

test("activation funnel milestones are recorded once through first publish", async () => {
  const base = Date.parse("2026-08-10T12:00:00.000Z");
  const harness = createHarness({
    promo: Array.from({ length: 50 }, (_, index) => `used-${index}`),
    states: { 440: { pending: { "30": { source: "naval", text: "Preview" } } } },
  });

  await sendUpdateAt(harness, message(440, "/start"), base);
  const startedAt = harness.user(440).setup.started_at;
  await sendUpdateAt(harness, message(440, "/add naval"), base + 1);
  await sendUpdateAt(harness, accountValidation(440, "naval", "readable"), base + 2);
  await sendUpdateAt(harness, message(440, "/timezone Europe/Kyiv"), base + 3);
  await sendUpdateAt(harness, callback(440, "timezone:confirm"), base + 4);
  await sendUpdateAt(harness, message(440, "/schedule 8"), base + 5);
  await sendUpdateAt(harness, message(440, "/channel @firstchannel"), base + 6);
  await sendUpdateAt(harness, callback(440, "p:30"), base + 7);

  const first = harness.user(440).setup;
  assert.equal(first.started_at, startedAt);
  assert.equal(first.first_valid_account_at, new Date(base + 2).toISOString());
  assert.equal(first.timezone_confirmed_at, new Date(base + 4).toISOString());
  assert.equal(first.digest_time_confirmed_at, new Date(base + 5).toISOString());
  assert.equal(first.activated_at, new Date(base + 5).toISOString());
  assert.equal(first.completed_at, first.activated_at);
  assert.equal(first.channel_connected_at, new Date(base + 6).toISOString());
  assert.equal(first.first_publish_at, new Date(base + 7).toISOString());

  const milestones = {
    started_at: first.started_at,
    first_valid_account_at: first.first_valid_account_at,
    timezone_confirmed_at: first.timezone_confirmed_at,
    digest_time_confirmed_at: first.digest_time_confirmed_at,
    activated_at: first.activated_at,
    channel_connected_at: first.channel_connected_at,
    first_publish_at: first.first_publish_at,
  };
  await sendUpdateAt(harness, message(440, "/timezone London"), base + 8);
  await sendUpdateAt(harness, callback(440, "timezone:confirm"), base + 9);
  await sendUpdateAt(harness, message(440, "/schedule 9"), base + 10);
  await sendUpdateAt(harness, message(440, "/channel @secondchannel"), base + 11);
  await sendUpdateAt(harness, callback(440, "p:30"), base + 12);
  for (const [field, value] of Object.entries(milestones)) {
    assert.equal(harness.user(440).setup[field], value, field);
  }
});

test("a successful Scheduled publish records the first-publish milestone once", async () => {
  const now = Date.parse("2026-08-12T12:00:00.000Z");
  const dueHour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv", hour: "2-digit", hourCycle: "h23",
  }).format(new Date()));
  const harness = createHarness({
    users: {
      441: activatedUser({
        channel: "@briefings",
        channel_verified: { id: "@briefings" },
        setup_reminder_eligible: true,
      }),
    },
    states: { 441: { pending: { "40": { source: "naval", text: "Preview" } } } },
    schedules: {
      "441:1": JSON.stringify({
        chat: 441, control: 1, ids: "40", tz: "Europe/Kyiv", hour: dueHour,
      }),
    },
    telegramResults: {
      editMessageText: () => {
        throw new Error("control update failed");
      },
    },
  });

  await sendScheduledAt(harness, now);
  assert.equal(harness.user(441).setup.first_publish_at, new Date(now).toISOString());
  assert.equal(harness.telegram.some(({ method }) => method === "copyMessages"), true);
});

test("public and forwarded private Publishing channels are verified before saving", async () => {
  const publicChannel = createHarness({ users: { 501: { channel: null } } });
  await sendUpdate(publicChannel, message(501, "/channel @publicchannel"));

  assert.equal(publicChannel.user(501).channel, "@publicchannel");
  assert.equal(publicChannel.user(501).channel_verified.id, "@publicchannel");
  assert.equal(publicChannel.user(501).channel_candidate, undefined);
  assert.deepEqual(publicChannel.telegram.map(({ method }) => method),
    ["getMe", "getChatMember", "sendMessage"]);
  assert.deepEqual(publicChannel.telegram[1].params,
    { chat_id: "@publicchannel", user_id: 999 });
  assert.match(sentTo(publicChannel, 501)[0], /Publishing channel verified/);

  const privateChannel = createHarness({ users: { 502: { channel: null } } });
  const forwarded = message(502, "forwarded post");
  forwarded.message.forward_origin = {
    type: "channel", chat: { id: -1001234567890, title: "Private News" },
  };
  await sendUpdate(privateChannel, forwarded);

  assert.equal(privateChannel.user(502).channel, -1001234567890);
  assert.deepEqual(privateChannel.telegram[1].params,
    { chat_id: -1001234567890, user_id: 999 });
  assert.match(sentTo(privateChannel, 502)[0], /Private News/);
});

test("posting to a verified channel answers before publishing", async () => {
  const harness = createHarness({
    users: {
      503: { channel: "@verified", channel_verified: { id: "@verified" } },
    },
    states: {
      503: { pending: { "30": { source: "naval", text: "Preview" } } },
    },
  });
  await sendUpdate(harness, callback(503, "p:30"));

  assert.deepEqual(harness.telegram.map(({ method }) => method),
    ["answerCallbackQuery", "copyMessages", "editMessageText"]);
});

test("a successful publish records its milestone before the control update", async () => {
  const harness = createHarness({
    users: {
      504: activatedUser({
        channel: "@verified", channel_verified: { id: "@verified" },
      }),
    },
    telegramResults: {
      editMessageText: () => {
        throw new Error("control update failed");
      },
    },
  });

  await sendUpdate(harness, callback(504, "p:30"));
  assert.ok(harness.user(504).setup.first_publish_at);
});

test("channel verification gives permission-specific repairs and retries", async () => {
  const cases = [
    {
      id: 510,
      initial: { ok: true, result: { status: "left" } },
      expected: /can’t access.*Add me.*administrator.*Post Messages/s,
    },
    {
      id: 511,
      initial: { ok: true, result: { status: "member" } },
      expected: /not an administrator.*Promote me.*Post Messages/s,
    },
    {
      id: 512,
      initial: {
        ok: true,
        result: { status: "administrator", can_post_messages: false },
      },
      expected: /can’t post messages.*Enable.*Post Messages/s,
    },
  ];
  for (const item of cases) {
    let repaired = false;
    const harness = createHarness({
      users: { [item.id]: { channel: null } },
      telegramResults: {
        getChatMember: () => repaired ? {
          ok: true,
          result: { status: "administrator", can_post_messages: true },
        } : item.initial,
      },
    });
    await sendUpdate(harness, message(item.id, "/channel @repairme"));

    assert.equal(harness.user(item.id).channel, null);
    assert.equal(harness.user(item.id).channel_candidate.id, "@repairme");
    const repair = harness.telegram.at(-1);
    assert.match(repair.params.text, item.expected);
    assert.equal(repair.params.reply_markup.inline_keyboard[0][0].callback_data,
      "channel:retry");

    repaired = true;
    const beforeRetry = harness.telegram.length;
    await sendUpdate(harness, callback(item.id, "channel:retry"));
    assert.equal(harness.user(item.id).channel, "@repairme");
    assert.deepEqual(harness.telegram.slice(beforeRetry).map(({ method }) => method),
      ["answerCallbackQuery", "getMe", "getChatMember", "sendMessage"]);
  }
});

test("stored channels cannot publish until their permissions are verified", async () => {
  const states = [
    { status: "left" },
    { status: "member" },
    { status: "administrator", can_post_messages: false },
  ];
  for (const [index, result] of states.entries()) {
    const id = 515 + index;
    const harness = createHarness({
      users: { [id]: { channel: "@legacy" } },
      states: {
        [id]: { pending: { "40": { source: "naval", text: "Preview" } } },
      },
      telegramResults: {
        getChatMember: { ok: true, result },
      },
    });
    await sendUpdate(harness, callback(id, "p:40"));

    assert.equal(harness.user(id).channel_verified, undefined);
    assert.equal(harness.user(id).channel_candidate.id, "@legacy");
    assert.equal(harness.user(id).publishing_intent.ids, "40");
    assert.deepEqual(harness.telegram.map(({ method }) => method),
      ["answerCallbackQuery", "getMe", "getChatMember", "sendMessage"]);
    assert.equal(harness.telegram.some(({ method }) => method === "copyMessages"), false);
  }
});

test("Post without a channel preserves the Preview and requires final confirmation", async () => {
  const pending = {
    "10": { source: "naval", text: "original", caption: "Original Preview" },
  };
  const harness = createHarness({
    users: { 520: { channel: null } }, states: { 520: { pending } },
  });
  await sendUpdate(harness, callback(520, "p:10,11"));

  assert.equal(harness.user(520).publishing_intent.ids, "10,11");
  assert.equal(harness.user(520).publishing_intent.control, 1);
  assert.equal(harness.user(520).publishing_intent.controls
    .inline_keyboard[0][0].callback_data, "p:10,11");
  assert.deepEqual(harness.state(520).pending, pending);
  assert.deepEqual(harness.telegram.map(({ method }) => method),
    ["answerCallbackQuery", "sendMessage"]);
  assert.match(sentTo(harness, 520)[0], /exact Preview is saved/);

  await sendUpdate(harness, message(520, "/channel @destination"));
  assert.equal(harness.telegram.some(({ method }) => method === "copyMessages"), false);
  const confirmation = harness.telegram.find(({ method, params }) =>
    method === "editMessageReplyMarkup" && params.message_id === 1);
  assert.deepEqual(confirmation.params.reply_markup.inline_keyboard[0]
    .map(({ text }) => text), ["Publish now", "Not now"]);
  assert.deepEqual(harness.state(520).pending, pending);

  const beforePublish = harness.telegram.length;
  await sendUpdate(harness, callback(520, "channel:publish"));
  assert.deepEqual(harness.telegram.slice(beforePublish).map(({ method }) => method),
    ["answerCallbackQuery", "copyMessages", "editMessageText"]);
  assert.deepEqual(harness.telegram[beforePublish + 1].params, {
    chat_id: "@destination", from_chat_id: 520, message_ids: [10, 11],
  });
  assert.equal(harness.user(520).publishing_intent, undefined);
});

test("declining final publication restores the Preview controls", async () => {
  const pending = {
    "20": { source: "naval", text: "original", caption: "Original Preview" },
  };
  const harness = createHarness({
    users: { 530: { channel: null } }, states: { 530: { pending } },
  });
  await sendUpdate(harness, callback(530, "p:20"));
  await sendUpdate(harness, message(530, "/channel @destination"));
  const beforeCancel = harness.telegram.length;
  await sendUpdate(harness, callback(530, "channel:not-now"));

  assert.deepEqual(harness.telegram.slice(beforeCancel).map(({ method }) => method),
    ["answerCallbackQuery", "editMessageReplyMarkup", "sendMessage"]);
  const controls = harness.telegram[beforeCancel + 1].params.reply_markup;
  assert.equal(controls.inline_keyboard[0][0].callback_data, "p:20");
  assert.equal(harness.user(530).publishing_intent, undefined);
  assert.deepEqual(harness.state(530).pending, pending);
  assert.equal(harness.telegram.some(({ method }) => method === "copyMessages"), false);
});
