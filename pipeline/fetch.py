"""Fetch recent tweets via twscrape using cookie-based auth (no login flow)."""

import asyncio
import logging
import os
from pathlib import Path

import requests
import twscrape

from .config import FETCH_RANGE, TMP_DIR

log = logging.getLogger(__name__)

_DB = Path("accounts.db")
_api: twscrape.API | None = None
_cookie_str: str = ""


def _parse_cookies(raw: str) -> str:
    """Extract auth_token and ct0 from a Netscape cookies.txt string."""
    auth_token = ct0 = ""
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        name, value = parts[5], parts[6]
        if name == "auth_token":
            auth_token = value
        elif name == "ct0":
            ct0 = value
    if not auth_token or not ct0:
        raise RuntimeError("cookies.txt missing auth_token or ct0 — re-export from browser")
    return f"auth_token={auth_token}; ct0={ct0}"


async def _get_api() -> twscrape.API:
    global _api, _cookie_str
    if _api is not None:
        return _api

    api = twscrape.API(str(_DB))
    cookies_raw = os.environ.get("TWITTER_COOKIES", "")
    username = os.environ.get("TWITTER_USERNAME", "xgist")

    if cookies_raw:
        _cookie_str = _parse_cookies(cookies_raw)
        await api.pool.add_account(
            username=username,
            password="n/a",
            email="n/a",
            email_password="",
            cookies=_cookie_str,
        )
        # login_all activates the account via cookie verification (not the
        # login form), so it works even from GitHub Actions IPs.
        await api.pool.login_all()
    else:
        password = os.environ.get("TWITTER_PASSWORD", "")
        email = os.environ.get("TWITTER_EMAIL", "")
        if not (username and password and email):
            raise RuntimeError(
                "Set TWITTER_COOKIES (preferred) or TWITTER_USERNAME+PASSWORD+EMAIL"
            )
        await api.pool.add_account(username, password, email, email)
        await api.pool.login_all()

    _api = api
    return _api


def _best_video_url(video: twscrape.MediaVideo) -> str:
    variants = sorted(video.variants, key=lambda v: v.bitrate, reverse=True)
    return variants[0].url if variants else ""


_DL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Referer": "https://x.com/",
}


def _download_media(tweet_id: str, media: twscrape.Media, dest: Path,
                    cookie_str: str = "") -> list[str]:
    headers = dict(_DL_HEADERS)
    if cookie_str:
        headers["Cookie"] = cookie_str

    items: list[tuple[str, str]] = []
    for i, photo in enumerate(media.photos):
        url = photo.url.split("?")[0] + "?format=jpg&name=large"
        items.append((url, f"photo_{i}.jpg"))
    for i, video in enumerate(media.videos):
        url = _best_video_url(video)
        if url:
            items.append((url, f"video_{i}.mp4"))

    paths: list[str] = []
    for url, name in items[:4]:
        out = dest / f"{tweet_id}_{name}"
        try:
            r = requests.get(url, headers=headers, timeout=60)
            r.raise_for_status()
            out.write_bytes(r.content)
            paths.append(str(out))
        except Exception as exc:
            log.warning("failed to download %s: %s", url, exc)
    return paths


class AuthError(Exception):
    """Raised when the session is invalid (cookies expired)."""


async def _fetch_async(handle: str) -> list[dict]:
    api = await _get_api()
    try:
        user = await api.user_by_login(handle)
    except Exception as exc:
        msg = str(exc)
        if "no active accounts" in msg.lower() or "403" in msg:
            raise AuthError(f"session invalid for @{handle}: {exc}") from exc
        log.error("could not resolve @%s: %s", handle, exc)
        return []
    if user is None:
        log.warning("@%s not found", handle)
        return []

    dest = TMP_DIR / handle
    dest.mkdir(parents=True, exist_ok=True)

    tweets: list[dict] = []
    try:
        async for tw in api.user_tweets(user.id, limit=FETCH_RANGE):
            if tw.retweetedTweet is not None:
                continue
            media_paths = _download_media(tw.id_str, tw.media, dest, _cookie_str) if tw.media else []
            tweets.append({
                "id": tw.id_str,
                "source": handle,
                "text": tw.rawContent or "",
                "date": tw.date,
                "favorites": tw.likeCount or 0,
                "retweets": tw.retweetCount or 0,
                "replies": tw.replyCount or 0,
                "media": media_paths,
            })
    except Exception as exc:
        log.error("error fetching @%s: %s", handle, exc)

    tweets.sort(key=lambda t: t["date"], reverse=True)
    return tweets


def fetch_source(handle: str) -> list[dict]:
    """Fetch recent tweets for one account. Returns tweets, newest first.
    Raises AuthError if the session appears invalid (cookies expired)."""
    try:
        return asyncio.get_event_loop().run_until_complete(_fetch_async(handle))
    except AuthError:
        raise
    except Exception as exc:
        log.error("fetch_source failed for @%s: %s", handle, exc)
        return []
