"""Main digest run: for every user due at this hour, fetch → rank → preview.

Executed by GitHub Actions every hour. Publishing itself happens in the
Cloudflare Worker when the user taps ✅ (see worker/worker.js).
"""

import logging
import os
import shutil
from datetime import datetime, timedelta, timezone
from statistics import median
from zoneinfo import ZoneInfo

from . import tg
from .caption import make_caption
from .config import (DEFAULT_TZ, MAX_TWEET_AGE_HOURS, TMP_DIR, load_feedback,
                     load_state, load_users, load_whitelist, save_state)
from .fetch import AuthError, fetch_source
from .media import prepare
from .rank import engagement, pick_top

log = logging.getLogger(__name__)


def _alert_cookie_expiry() -> None:
    import json
    import urllib.request
    admin_id = os.getenv("ADMIN_ID", "").strip()
    token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    log.warning("X session invalid — cookies likely expired")
    if not (admin_id and token):
        return
    try:
        urllib.request.urlopen(
            f"https://api.telegram.org/bot{token}/sendMessage",
            data=json.dumps({"chat_id": admin_id, "text": (
                "⚠️ XGist: X cookies expired — digests paused.\n\n"
                "Re-export cookies.txt from your browser and update "
                "TWITTER_COOKIES in GitHub Secrets."
            )}).encode(),
            timeout=10,
        )
    except Exception as exc:
        log.error("failed to send cookie-expiry alert: %s", exc)


# GitHub's hourly cron fires late or skips slots entirely, so a scheduled
# hour still counts as due for this long after it passed (if not yet served).
CATCH_UP_HOURS = 2


def _due_slot(cfg: dict, user_state: dict, now: datetime) -> str | None:
    """Return the "YYYY-MM-DD HH" slot this run should serve, or None."""
    if not cfg.get("channel") or not cfg.get("sources"):
        return None
    try:
        tz = ZoneInfo(cfg.get("timezone") or DEFAULT_TZ)
    except Exception:
        tz = ZoneInfo(DEFAULT_TZ)
    local = now.astimezone(tz)
    if os.getenv("FORCE_ALL"):
        return local.strftime("%Y-%m-%d %H")
    hours = cfg.get("hours") or [9]
    served = user_state.get("last_run_hour") or ""
    for back in range(CATCH_UP_HOURS + 1):
        slot = local - timedelta(hours=back)
        if slot.hour in hours:
            key = slot.strftime("%Y-%m-%d %H")
            if key > served:
                return key
    return None


# Mirrors LIMITS in worker/worker.js — keep the two in sync.
FREE_HOURS = 1
FREE_SOURCES = 5


def _apply_plan(uid: str, cfg: dict, whitelist: list, now: datetime) -> dict:
    """Clamp a lapsed/free user's config to free-tier limits.

    The Worker enforces limits when settings change; this catches the case
    where a paid subscription expired after the settings were saved.
    """
    paid = False
    if cfg.get("paid_until"):
        try:
            paid = datetime.fromisoformat(cfg["paid_until"]) > now
        except ValueError:
            pass
    if paid or uid in whitelist:
        return cfg
    clamped = dict(cfg)
    clamped["hours"] = (cfg.get("hours") or [9])[:FREE_HOURS]
    clamped["sources"] = (cfg.get("sources") or [])[:FREE_SOURCES]
    return clamped


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
    whitelist = load_whitelist()
    users = {uid: _apply_plan(uid, cfg, whitelist, now)
             for uid, cfg in load_users().items()}
    state = load_state()

    force_user = os.getenv("FORCE_USER", "").strip()
    if force_user:
        due = {force_user: users[force_user]} if force_user in users else {}
        if not due:
            log.error("FORCE_USER %s is not a registered user", force_user)
            return
    else:
        slots = {uid: _due_slot(cfg, state.get(uid, {}), now)
                 for uid, cfg in users.items()}
        due = {uid: cfg for uid, cfg in users.items() if slots[uid]}
    if not due:
        log.info("no users due at %s UTC", now.strftime("%H:%M"))
        return

    if TMP_DIR.exists():
        shutil.rmtree(TMP_DIR)

    # Fetch each unique source once, no matter how many users watch it.
    sources = sorted({s for cfg in due.values() for s in cfg["sources"]})
    log.info("fetching %d sources for %d users", len(sources), len(due))
    fetched: dict[str, list] = {}
    for s in sources:
        try:
            fetched[s] = fetch_source(s)
        except AuthError:
            _alert_cookie_expiry()
            return
        fetched.setdefault(s, [])

    # Each account's typical engagement (median over its fetched sample) —
    # lets a small account's hit compete with a big account's routine post.
    for tweets in fetched.values():
        if tweets:
            baseline = median(engagement(t) for t in tweets)
            for t in tweets:
                t["baseline"] = baseline

    feedback = load_feedback()

    for uid, cfg in due.items():
        user_state = state.setdefault(uid, {})
        start = _window_start(user_state, now)
        candidates = [
            t for s in cfg["sources"] for t in fetched.get(s, [])
            if start < t["date"] <= now
        ]
        log.info("user %s: %d candidates since %s", uid, len(candidates), start)

        sent = 0
        ranking_cfg = {**cfg, "_feedback": feedback.get(uid, [])}
        for tweet in pick_top(candidates, ranking_cfg):
            try:
                media = prepare(tweet["media"])
                if not media and not tweet["text"]:
                    continue
                caption = make_caption(tweet, cfg)
                msgs = tg.send_preview(int(uid), media, caption)
                content_ids = [m["message_id"] for m in msgs]
                dest = cfg["channel"] if isinstance(cfg["channel"], str) else "your channel"
                tg.send_controls(
                    int(uid), content_ids,
                    f'<a href="https://x.com/{tweet["source"]}/status/{tweet["id"]}">'
                    f'@{tweet["source"]}</a>'
                    f" · ❤️ {tweet['favorites']} · 🔁 {tweet['retweets']}"
                    f"\nPublish to {dest}?",
                )
                # Remember what this preview was about so the Worker can log
                # the user's ✅/❌ verdict for future ranking, and re-edit the
                # preview (media file_ids + caption) for the 🫥 spoiler toggle.
                refs = tg.media_refs(msgs)
                pending = user_state.setdefault("pending", {})
                pending[str(content_ids[0])] = {
                    "source": tweet["source"],
                    "text": tweet["text"][:280],
                    "media": refs,
                    "caption": caption[:1024] if refs else caption[:4096],
                }
                while len(pending) > 40:
                    pending.pop(next(iter(pending)))
                sent += 1
            except Exception:
                log.exception("failed to preview tweet %s for user %s", tweet["id"], uid)

        if sent == 0 and (cfg.get("notify_empty") or force_user):
            try:
                tg.send_text(
                    int(uid),
                    "Nothing new from your sources in the window."
                    if cfg.get("sources") else
                    "You have no sources yet — /add some X accounts first.")
            except Exception:
                log.exception("failed to notify user %s", uid)

        tz = ZoneInfo(cfg.get("timezone") or DEFAULT_TZ)
        # Record the *slot* served (not the wall-clock hour), so a late run
        # that catches up a missed hour doesn't block the next scheduled one.
        user_state["last_run_hour"] = (
            slots.get(uid) if not force_user else None
        ) or now.astimezone(tz).strftime("%Y-%m-%d %H")
        user_state["last_digest_at"] = now.isoformat()

    save_state(state)
    log.info("done")


if __name__ == "__main__":
    main()
