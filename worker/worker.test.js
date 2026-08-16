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
