# X → Telegram Digest Bot

A Telegram bot that watches X (Twitter) accounts, picks the most interesting
new posts with Claude, and sends you previews at the hours you choose. One tap
on **✅ Post** and the post (media + caption) is published to your Telegram
channel instantly.

Runs entirely on free infrastructure — no server to maintain.

```
every hour ──▶ GitHub Actions (free)                 Cloudflare Worker (free)
              fetch tweets via gallery-dl                    ▲ │
              rank with Claude, write captions      button   │ │ copyMessages
              send previews to user's Telegram ──▶  tap ─────┘ ▼
                                                       user's channel
```

- **GitHub repo** = code only
- **Upstash Redis (free tier)** = the database — user configs, pending
  previews, ✅/❌ feedback — shared by the Worker and the pipeline
- **GitHub Actions** = hourly scheduled runner (~1–2 min per run)
- **Cloudflare Worker** = instant bot command + button handler
- **Only real cost:** Claude API captions/ranking, roughly $0.5–2/month

---

## Setup (one-time, ~40 minutes)

You need: a GitHub account, a Cloudflare account (free), a Telegram account,
an Anthropic API key ($5 minimum top-up lasts months), and a spare/burner X
account for reading tweets.

### 1. Create the Telegram bot

1. In Telegram, open **@BotFather** → `/newbot` → pick a name and username.
2. Save the token it gives you (`123456:ABC-...`) — this is `TELEGRAM_BOT_TOKEN` / `BOT_TOKEN`.

### 2. Push this folder to a private GitHub repo

```bash
cd instagram-autopost
git init
git add .
git commit -m "initial"
# create a PRIVATE repo on github.com (e.g. xdigest), then:
git remote add origin git@github.com:YOURNAME/xdigest.git
git push -u origin main
```

### 3. Get X cookies (lets gallery-dl read timelines)

1. Log in to x.com in your browser **with a burner account** (recommended —
   scraping violates X ToS and the account could get flagged).
2. Install a "cookies.txt" export extension (e.g. *Get cookies.txt LOCALLY*)
   and export cookies for x.com in Netscape format.
3. Keep the file's **content** handy for the next step. Never commit it.

### 4. Create the free Upstash Redis database

All bot data (user configs, pending previews, feedback history) lives in a
free Upstash Redis database, reachable over plain HTTPS from both the Worker
and GitHub Actions.

1. [console.upstash.com](https://console.upstash.com) → Redis → **Create
   Database** (free tier; pick a region close to you).
2. On the database page, open the **REST API** section and copy
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

### 5. Add GitHub secrets

Repo → Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `ANTHROPIC_API_KEY` | from console.anthropic.com → API keys |
| `TWITTER_COOKIES` | full content of the exported cookies.txt |
| `UPSTASH_REDIS_REST_URL` | from step 4 |
| `UPSTASH_REDIS_REST_TOKEN` | from step 4 |

Optionally, under *Variables*, set `DEFAULT_TZ` (default is `Europe/Kyiv`).

### 6. Create a GitHub token for the Worker

The Worker triggers the digest workflow (hourly cron and `/gen_digest_now`).

1. GitHub → Settings (your profile) → Developer settings →
   **Fine-grained personal access tokens** → Generate new token.
2. Repository access: *Only select repositories* → your repo.
3. Permissions → Repository permissions → **Actions: Read and write**.
4. Save the token — this is `GH_TOKEN`.

### 7. Deploy the Cloudflare Worker

1. dash.cloudflare.com → Workers & Pages → **Create Worker** → deploy the
   hello-world, then **Edit code**, replace everything with
   [`worker/worker.js`](worker/worker.js), **Deploy**.
2. Worker → Settings → Variables and Secrets → add six **secrets**:
   - `BOT_TOKEN` — the BotFather token
   - `GH_TOKEN` — from step 6
   - `GH_REPO` — e.g. `YOURNAME/xdigest`
   - `WEBHOOK_SECRET` — any random string you invent (e.g. from a password generator)
   - `UPSTASH_REDIS_REST_URL` — from step 4
   - `UPSTASH_REDIS_REST_TOKEN` — from step 4
3. Add plain **variables** (not secrets):
   - `BOT_USERNAME` — your bot's username without the `@` (used by the landing page button)
   - `ADMIN_USERNAME` — your Telegram username without `@` (e.g. `velhrh`) —
     grants you the admin commands
   - `ADMIN_ID` (recommended) — your numeric Telegram id; send `/id` to the
     bot once it's live, then add this. Usernames can be released and
     re-claimed by strangers; the numeric id is the tamper-proof check.
4. Worker → Settings → **Triggers** → Cron Triggers → add `0 * * * *`.
   This makes the Worker start the hourly digest run — Cloudflare's cron is
   punctual, while GitHub's own scheduler silently skips slots (the schedule
   in `digest.yml` is kept only as a fallback).
5. Copy the worker URL (like `https://xdigest.YOURNAME.workers.dev`).

The worker URL doubles as your **landing page**: opening it in a browser shows
a SEO-ready product page (with `robots.txt` and `sitemap.xml`), while Telegram
talks to the same URL via POST. For serious SEO later, attach a custom domain
to the Worker (Cloudflare → Worker → Settings → Domains & Routes) — domains
rank; `workers.dev` subdomains rank poorly.

### 8. Point Telegram at the Worker

Run this once in any terminal (or paste into the browser address bar after
replacing the placeholders):

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<WEBHOOK_SECRET>"
```

Expected reply: `{"ok":true,...,"description":"Webhook was set"}`.

Then open `<WORKER_URL>/setup-commands?key=<WEBHOOK_SECRET>` in the browser
once — this registers the bot's "/" command autocomplete menu in Telegram
(re-open it after ever changing the command list, or after setting `ADMIN_ID`
to also get admin commands in your autocomplete).

### 9. Configure yourself as the first user

1. Create your Telegram channel (or use an existing one).
2. Channel → Administrators → add your bot with **Post messages** permission.
3. Open a private chat with your bot:

```
/channel @yourchannel      (for a private channel: forward it any message from the channel)
/add naval pmarca
/times 9,18
/timezone Europe/Kyiv
/interests AI, startups
/style short summaries in Ukrainian, no emoji
```

### 10. Test it

Repo → Actions → **Digest** → Run workflow → tick **force** → Run. Within a
couple of minutes the bot should message you previews. Tap ✅ and check your
channel.

Done. From now on it runs automatically at your configured hours.
(Note: GitHub schedules can lag 5–15 minutes past the hour — normal.)

---

## Bot commands

See `/help` in the bot. Summary: `/channel`, `/add`, `/remove`, `/list`,
`/times`, `/timezone`, `/limit`, `/interests`, `/style`, `/settings`.

## How multiple users work

Anyone who talks to the bot can configure their own sources, hours and
channel — configs live in Upstash Redis (`user:<id>`, one entry per Telegram
user; the full key schema is documented in `pipeline/config.py`). Sources are
fetched once per run regardless of how many users watch them.

**Plans:** free users get 1 digest time/day and 5 sources; Pro users get
6 times/day and 25 sources (the `LIMITS` table in `worker/worker.js`,
mirrored by `FREE_*` constants in `pipeline/digest.py`).

**Payments:** `/pro` sells a monthly auto-renewing subscription via Telegram
Stars — no external payment provider needed. Price is the `PRO_PRICE_STARS`
Worker variable (default 550 ≈ $7; you receive ~65-70% after Telegram/store
fees). Stars accumulate on the bot's balance (@BotFather → your bot →
Payments) and are withdrawn through fragment.com after a 21-day hold. Users
manage/cancel the subscription in Telegram Settings → My Stars; when it
lapses, the pipeline automatically clamps them back to free limits.

**Admin commands** (only for `ADMIN_USERNAME`/`ADMIN_ID`):
`/whitelist <id>` and `/unwhitelist <id>` grant/revoke free pro access (ask
the person to send `/id` to the bot to learn their id), `/whitelisted` lists
ids, `/users` shows everyone registered. Whitelist yourself and your other
accounts right after setup.

## Extending to other platforms (Instagram, etc.)

Publishing to Telegram happens instantly in the Worker via `copyMessages`.
Other targets plug in through `pipeline/publishers/` (see `base.py`); the
Worker would route those to a `workflow_dispatch` job instead of copying.
`instagram_graph.py` contains a documented stub for the official Instagram
Graph API.

## Costs & risks

- GitHub Actions free tier: 2,000 min/month; hourly runs use well under half,
  and hours with no due users exit in seconds.
- Claude usage: one ranking call + a few caption calls per digest — cents.
  Model is configurable via the `CLAUDE_MODEL` env var (default
  `claude-sonnet-4-6`; `claude-haiku-4-5` is ~5× cheaper).
- Reading X via cookies is against X's ToS. Use a burner account; expect to
  re-export cookies occasionally (when runs start returning nothing).

## Local development

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export TELEGRAM_BOT_TOKEN=... ANTHROPIC_API_KEY=... FORCE_ALL=1
export UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=...
cp ~/Downloads/x.com_cookies.txt cookies.txt
python -m pipeline.digest
```
