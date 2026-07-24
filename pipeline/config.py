import json
import os
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
TMP_DIR = ROOT / "tmp"

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6")
DEFAULT_TZ = os.getenv("DEFAULT_TZ", "Europe/Kyiv")

# Tweets older than this are never proposed, even on a user's first digest.
MAX_TWEET_AGE_HOURS = int(os.getenv("MAX_TWEET_AGE_HOURS", "26"))
# How many recent posts to pull per source account on each run.
FETCH_RANGE = int(os.getenv("FETCH_RANGE", "30"))
# How many candidates go to Claude for ranking.
SHORTLIST_SIZE = int(os.getenv("SHORTLIST_SIZE", "12"))
DEFAULT_POSTS_PER_DIGEST = 3
# Media items to attach to a thread-post Preview (Telegram albums hold 10;
# higher than a Digest preview, which stays light).
THREAD_MEDIA_CAP = 10

# Upstash Redis REST API — the shared store between this pipeline and the
# Cloudflare Worker. Keys (keep in sync with worker/worker.js):
#   user:<id>     — JSON user config (channel, sources, hours, paused, …)
#                   paused: bool — when set, the digest skips this user (no fetch)
#   uids          — set of registered user ids
#   whitelist     — set of ids with free Pro
#   promo         — set of ids that claimed the early-access month
#   state:<id>    — JSON per-user state (pending previews, last run)
#   feedback:<id> — list of JSON ✅/❌ verdicts, oldest first
#   sched         — hash <chatId>:<controlId> → JSON scheduled-publish job
#   quota:<id>    — thread-post charges in the rolling 24h window; the Worker
#                   INCRs before dispatching, the pipeline DECRs on failed fetch
UPSTASH_URL = os.getenv("UPSTASH_REDIS_REST_URL", "").rstrip("/")
UPSTASH_TOKEN = os.getenv("UPSTASH_REDIS_REST_TOKEN", "")

_HEADERS = {"Authorization": f"Bearer {UPSTASH_TOKEN}"}


def _redis(*cmd):
    resp = requests.post(UPSTASH_URL, json=list(cmd), headers=_HEADERS, timeout=20)
    data = resp.json()
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(f"redis {cmd[0]} failed: {data['error']}")
    return data["result"]


def _redis_pipeline(commands: list[list]) -> list:
    if not commands:
        return []
    resp = requests.post(f"{UPSTASH_URL}/pipeline", json=commands,
                         headers=_HEADERS, timeout=30)
    results = []
    for cmd, item in zip(commands, resp.json()):
        if "error" in item:
            raise RuntimeError(f"redis {cmd[0]} failed: {item['error']}")
        results.append(item["result"])
    return results


def _uids() -> list[str]:
    return sorted(_redis("SMEMBERS", "uids") or [])


def _mget_json(prefix: str) -> dict:
    uids = _uids()
    if not uids:
        return {}
    raws = _redis("MGET", *[f"{prefix}:{uid}" for uid in uids])
    return {uid: json.loads(raw) for uid, raw in zip(uids, raws) if raw}


def load_users() -> dict:
    return _mget_json("user")


def load_whitelist() -> list:
    return _redis("SMEMBERS", "whitelist") or []


def load_state() -> dict:
    return _mget_json("state")


def load_feedback() -> dict:
    """Approve/skip history written by the Worker (feedback:<id> lists)."""
    uids = _uids()
    rows = _redis_pipeline([["LRANGE", f"feedback:{uid}", "0", "-1"] for uid in uids])
    return {uid: [json.loads(r) for r in row] for uid, row in zip(uids, rows) if row}


def save_user_state(uid: str, user_state: dict) -> None:
    _redis("SET", f"state:{uid}", json.dumps(user_state, ensure_ascii=False))


def refund_thread_quota(uid: str) -> None:
    """Undo one thread-post quota charge after a failed fetch, so the failure
    costs the user nothing. The Worker charges quota:<id> before dispatching
    (see issue #6); this is the matching refund. Clamped at 0 so a race can't
    drive the counter negative, and KEEPTTL preserves the rolling window."""
    remaining = _redis("DECR", f"quota:{uid}")
    if isinstance(remaining, int) and remaining < 0:
        _redis("SET", f"quota:{uid}", "0", "KEEPTTL")


def should_alert(key: str, ttl_seconds: int) -> bool:
    """Rate-limit admin alerts: True at most once per ttl for a given key.

    Uses SET NX EX so overlapping runs (and every due slot across the day)
    don't spam the same warning. Fails open — if Redis is unreachable we'd
    rather send a duplicate alert than swallow it.
    """
    try:
        return _redis("SET", f"alert:{key}", "1", "NX", "EX", ttl_seconds) == "OK"
    except Exception:
        return True
