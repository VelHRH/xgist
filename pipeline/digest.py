"""Main digest run: for every user due at this hour, fetch → rank → preview.

Executed by GitHub Actions every hour. Publishing itself happens in the
Cloudflare Worker when the user taps ✅ (see worker/worker.js).
"""

import logging
import os
import shutil
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import tg
from .caption import make_caption
from .config import (DEFAULT_TZ, MAX_TWEET_AGE_HOURS, TMP_DIR, load_state,
                     load_users, save_state)
from .fetch import fetch_source
from .media import prepare
from .rank import pick_top

log = logging.getLogger(__name__)


def _is_due(cfg: dict, user_state: dict, now: datetime) -> bool:
    if not cfg.get("channel") or not cfg.get("sources"):
        return False
    if os.getenv("FORCE_ALL"):
        return True
    try:
        tz = ZoneInfo(cfg.get("timezone") or DEFAULT_TZ)
    except Exception:
        tz = ZoneInfo(DEFAULT_TZ)
    local = now.astimezone(tz)
    if local.hour not in (cfg.get("hours") or [9]):
        return False
    # Guard against double runs within the same local hour.
    last_run = user_state.get("last_run_hour")
    return last_run != local.strftime("%Y-%m-%d %H")


def _window_start(user_state: dict, now: datetime) -> datetime:
    floor = now - timedelta(hours=MAX_TWEET_AGE_HOURS)
    last = user_state.get("last_digest_at")
    if last:
        try:
            return max(datetime.fromisoformat(last), floor)
        except ValueError:
            pass
    return floor


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    now = datetime.now(timezone.utc)
    users = load_users()
    state = load_state()

    due = {uid: cfg for uid, cfg in users.items()
           if _is_due(cfg, state.get(uid, {}), now)}
    if not due:
        log.info("no users due at %s UTC", now.strftime("%H:%M"))
        return

    if TMP_DIR.exists():
        shutil.rmtree(TMP_DIR)

    # Fetch each unique source once, no matter how many users watch it.
    sources = sorted({s for cfg in due.values() for s in cfg["sources"]})
    log.info("fetching %d sources for %d users", len(sources), len(due))
    fetched = {s: fetch_source(s) for s in sources}

    for uid, cfg in due.items():
        user_state = state.setdefault(uid, {})
        start = _window_start(user_state, now)
        candidates = [
            t for s in cfg["sources"] for t in fetched.get(s, [])
            if start < t["date"] <= now
        ]
        log.info("user %s: %d candidates since %s", uid, len(candidates), start)

        sent = 0
        for tweet in pick_top(candidates, cfg):
            try:
                media = prepare(tweet["media"])
                if not media and not tweet["text"]:
                    continue
                caption = make_caption(tweet, cfg)
                content_ids = tg.send_preview(int(uid), media, caption)
                tg.send_controls(
                    int(uid), content_ids,
                    f"@{tweet['source']} · ❤️ {tweet['favorites']} · 🔁 {tweet['retweets']}"
                    f"\nPublish to {cfg['channel']}?",
                )
                sent += 1
            except Exception:
                log.exception("failed to preview tweet %s for user %s", tweet["id"], uid)

        if sent == 0 and cfg.get("notify_empty"):
            try:
                tg.send_text(int(uid), "Nothing interesting from your sources this time.")
            except Exception:
                log.exception("failed to notify user %s", uid)

        tz = ZoneInfo(cfg.get("timezone") or DEFAULT_TZ)
        user_state["last_run_hour"] = now.astimezone(tz).strftime("%Y-%m-%d %H")
        user_state["last_digest_at"] = now.isoformat()

    save_state(state)
    log.info("done")


if __name__ == "__main__":
    main()
