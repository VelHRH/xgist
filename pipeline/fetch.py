"""Fetch recent media tweets for an X account via gallery-dl."""

import json
import logging
import subprocess
from datetime import datetime, timezone

from .config import COOKIES_FILE, FETCH_RANGE, TMP_DIR

log = logging.getLogger(__name__)

_DATE_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S%z")


def _parse_date(value):
    if not value:
        return None
    for fmt in _DATE_FORMATS:
        try:
            dt = datetime.strptime(str(value), fmt)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def fetch_source(handle: str) -> list[dict]:
    """Download recent media posts of one account. Returns tweets, newest first."""
    dest = TMP_DIR / handle
    dest.mkdir(parents=True, exist_ok=True)
    cmd = [
        "gallery-dl",
        "--write-metadata",
        "--range", f"1-{FETCH_RANGE}",
        "-D", str(dest),
    ]
    if COOKIES_FILE.exists():
        cmd += ["--cookies", str(COOKIES_FILE)]
    cmd.append(f"https://x.com/{handle}/media")

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if proc.returncode != 0:
            log.warning("gallery-dl exited %s for @%s: %s",
                        proc.returncode, handle, proc.stderr[-500:])
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        log.error("gallery-dl failed for @%s: %s", handle, exc)
        return []

    return _parse_dir(dest, handle)


def _parse_dir(dest, handle: str) -> list[dict]:
    tweets: dict[str, dict] = {}
    for meta_path in sorted(dest.glob("*.json")):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        tweet_id = str(meta.get("tweet_id") or "")
        if not tweet_id:
            continue
        if meta.get("retweet_id"):  # skip retweets, only original posts
            continue
        tweet = tweets.setdefault(tweet_id, {
            "id": tweet_id,
            "source": handle,
            "text": (meta.get("content") or "").strip(),
            "date": _parse_date(meta.get("date")),
            "favorites": int(meta.get("favorite_count") or 0),
            "retweets": int(meta.get("retweet_count") or 0),
            "media": [],
        })
        media_path = meta_path.with_suffix("")  # strips the trailing .json
        if media_path.exists():
            tweet["media"].append(str(media_path))

    result = [t for t in tweets.values() if t["date"]]
    result.sort(key=lambda t: t["date"], reverse=True)
    return result
