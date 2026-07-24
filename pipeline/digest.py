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
from .config import (DEFAULT_TZ, MAX_TWEET_AGE_HOURS, THREAD_MEDIA_CAP, TMP_DIR,
                     load_feedback, load_state, load_users, load_whitelist,
                     refund_thread_quota, save_user_state, should_alert)
from .fetch import AuthError, fetch_source, fetch_thread
from .media import prepare
from .rank import engagement, pick_top

log = logging.getLogger(__name__)


def _alert_admin(text: str) -> None:
    import json
    import urllib.request
    admin_id = os.getenv("ADMIN_ID", "").strip()
    token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    if not (admin_id and token):
        return
    try:
        # Telegram rejects the body as 400 unless it's declared JSON — urllib
        # otherwise defaults to form-urlencoded and the fields don't parse.
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/sendMessage",
            data=json.dumps({"chat_id": admin_id, "text": text}).encode(),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as exc:
        log.error("failed to send admin alert: %s", exc)


def _alert_cookie_expiry() -> None:
    log.warning("X session invalid — cookies likely expired")
    _alert_admin(
        "⚠️ XGist: X cookies expired — digests paused.\n\n"
        "Re-export cookies.txt from your browser and update "
        "TWITTER_COOKIES in GitHub Secrets."
    )


def _alert_fetch_broken(sources: int) -> None:
    """Every source resolved but returned nothing — X likely changed its
    web bundle and twscrape can't build the transaction-id header. Distinct
    from cookie expiry (which raises AuthError first)."""
    log.warning("fetch returned 0 tweets across all %d sources", sources)
    # Once per 6h so every due slot across the day doesn't re-ping.
    if should_alert("fetch_broken", 6 * 3600):
        _alert_admin(
            "🛑 XGist: fetched all sources but got 0 tweets — X scraping is "
            "broken (likely a twscrape XClientTxId breakage after an X "
            "change), so digests are silently empty.\n\n"
            "Check https://github.com/vladkens/twscrape/issues for a fix "
            "release, then bump the pin in requirements.txt."
        )


# GitHub's hourly cron fires late or skips slots entirely, so a scheduled
# hour still counts as due for this long after it passed (if not yet served).
CATCH_UP_HOURS = 2


def _due_slot(cfg: dict, user_state: dict, now: datetime) -> str | None:
    """Return the "YYYY-MM-DD HH" slot this run should serve, or None."""
    if cfg.get("paused"):
        return None
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


# Tweets posted shortly before the previous digest get a second look — their
# engagement had barely formed when first considered, so a future viral hit
# could lose once and never be seen again. The `proposed` id list keeps the
# overlap from re-proposing tweets that already got a preview.
RECONSIDER_HOURS = 2


def _window_start(user_state: dict, now: datetime) -> datetime:
    floor = now - timedelta(hours=MAX_TWEET_AGE_HOURS)
    last = user_state.get("last_digest_at")
    if last:
        try:
            since = datetime.fromisoformat(last) - timedelta(hours=RECONSIDER_HOURS)
            return max(since, floor)
        except ValueError:
            pass
    return floor


# Cap on stored pending previews per user — the Worker looks these up by the
# preview's first message id when the user taps a control.
PENDING_CAP = 40


def _record_pending(user_state: dict, content_ids: list[int], *,
                    source: str, text: str, caption: str, refs: list) -> None:
    """Remember a sent preview so the Worker can log the user's ✅/❌ verdict
    for future ranking and re-edit the media/caption for the 🫥 spoiler toggle.
    Keyed by the first content message id; oldest entries drop past PENDING_CAP.
    Shared by the Digest loop and the thread flow so their limits stay in sync."""
    pending = user_state.setdefault("pending", {})
    pending[str(content_ids[0])] = {
        "source": source,
        "text": text[:280],
        "media": refs,
        "caption": caption[:1024] if refs else caption[:4096],
    }
    while len(pending) > PENDING_CAP:
        pending.pop(next(iter(pending)))


def run_thread(thread_url: str) -> None:
    """On-demand flow: build a single Thread-post Preview from a pasted link
    and append it to the target user's pending previews, without touching any
    Digest scheduling state. The target chat id rides in on FORCE_USER, the
    same input the Digest uses to run for one user. On a failed fetch the
    user's quota charge is refunded so the failure costs them nothing."""
    uid = os.getenv("FORCE_USER", "").strip()
    if not uid:
        log.error("THREAD_URL set but no target user (FORCE_USER) — nothing to do")
        return
    cfg = load_users().get(uid)
    if cfg is None:
        log.error("thread target %s is not a registered user", uid)
        return

    if TMP_DIR.exists():
        shutil.rmtree(TMP_DIR)

    try:
        thread = fetch_thread(thread_url)
    except Exception:
        log.exception("thread fetch failed for user %s (%s) — refunding quota",
                      uid, thread_url)
        try:
            refund_thread_quota(uid)
        except Exception:
            log.exception("quota refund failed for user %s", uid)
        return

    media = prepare(thread["media"], limit=THREAD_MEDIA_CAP)
    if not media and not thread["text"]:
        log.warning("thread %s has neither media nor text — skipping", thread_url)
        return

    caption = make_caption(thread, cfg)
    msgs = tg.send_preview(int(uid), media, caption)
    content_ids = [m["message_id"] for m in msgs]
    dest = cfg["channel"] if isinstance(cfg.get("channel"), str) else "your channel"
    tg.send_controls(
        int(uid), content_ids,
        f'<a href="https://x.com/{thread["source"]}/status/{thread["id"]}">'
        f'@{thread["source"]}</a>'
        f" · ❤️ {thread['favorites']} · 🔁 {thread['retweets']} · 🧵"
        f"\nPublish to {dest}?",
    )

    # Append to this user's pending previews only — leave last_run_hour,
    # proposed and last_digest_at (the Digest's scheduling state) untouched.
    user_state = load_state().get(uid, {})
    _record_pending(user_state, content_ids, source=thread["source"],
                    text=thread["text"], caption=caption, refs=tg.media_refs(msgs))
    save_user_state(uid, user_state)
    log.info("thread preview delivered to user %s", uid)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    thread_url = os.getenv("THREAD_URL", "").strip()
    if thread_url:
        run_thread(thread_url)
        return

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

    # A quiet account still has *some* recent posts in FETCH_RANGE, so zero
    # tweets across every source means fetching itself is broken, not a slow
    # news day. Alert and bail without advancing last_run_hour, so the next
    # slot retries and the digest self-heals once twscrape works again.
    if sources and not any(fetched.values()):
        _alert_fetch_broken(len(sources))
        return

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
        already_proposed = set(user_state.get("proposed") or [])
        candidates = [
            t for s in cfg["sources"] for t in fetched.get(s, [])
            if start < t["date"] <= now and t["id"] not in already_proposed
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
                dest = cfg["channel"] if isinstance(cfg.get("channel"), str) else "your channel"
                tg.send_controls(
                    int(uid), content_ids,
                    f'<a href="https://x.com/{tweet["source"]}/status/{tweet["id"]}">'
                    f'@{tweet["source"]}</a>'
                    f" · ❤️ {tweet['favorites']} · 🔁 {tweet['retweets']}"
                    f"\nPublish to {dest}?",
                )
                _record_pending(user_state, content_ids, source=tweet["source"],
                                text=tweet["text"], caption=caption,
                                refs=tg.media_refs(msgs))
                proposed = user_state.setdefault("proposed", [])
                proposed.append(tweet["id"])
                del proposed[:-200]
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
        # Save right away so the Worker sees this user's pending previews as
        # soon as their digest lands, not after every user is processed.
        save_user_state(uid, user_state)

    log.info("done")


if __name__ == "__main__":
    main()
