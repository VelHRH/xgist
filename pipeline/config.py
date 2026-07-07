import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
USERS_FILE = ROOT / "users.json"
STATE_FILE = ROOT / "state.json"
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


def _load_json(path: Path, fallback: dict) -> dict:
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return fallback


def load_users() -> dict:
    return _load_json(USERS_FILE, {"users": {}}).get("users", {})


def load_whitelist() -> list:
    return _load_json(USERS_FILE, {"users": {}}).get("whitelist", [])


def load_state() -> dict:
    return _load_json(STATE_FILE, {"users": {}}).get("users", {})


def load_feedback() -> dict:
    """Approve/skip history written by the Worker (feedback.json)."""
    return _load_json(ROOT / "feedback.json", {"users": {}}).get("users", {})


def save_state(users_state: dict) -> None:
    STATE_FILE.write_text(
        json.dumps({"users": users_state}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
