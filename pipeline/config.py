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

# Upstash Redis REST API — the shared store between this pipeline and the
# Cloudflare Worker. Keys (keep in sync with worker/worker.js):
#   user:<id>     — JSON user config
#   uids          — set of registered user ids
#   whitelist     — set of ids with free Pro
#   promo         — set of ids that claimed the early-access month
#   state:<id>    — JSON per-user state (pending previews, last run)
#   feedback:<id> — list of JSON ✅/❌ verdicts, oldest first
#   sched         — hash <chatId>:<controlId> → JSON scheduled-publish job
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
