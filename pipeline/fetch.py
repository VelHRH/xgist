"""Fetch recent tweets for an X account via twscrape (username/password auth)."""

import asyncio
import logging
import os
import urllib.request
from pathlib import Path

import twscrape

from .config import FETCH_RANGE, TMP_DIR

log = logging.getLogger(__name__)

_DB = Path("accounts.db")  # cached by GitHub Actions between runs


async def _ensure_logged_in(api: twscrape.API) -> None:
    username = os.environ.get("TWITTER_USERNAME", "")
    password = os.environ.get("TWITTER_PASSWORD", "")
    email = os.environ.get("TWITTER_EMAIL", "")
    if not (username and password and email):
        raise RuntimeError("TWITTER_USERNAME / TWITTER_PASSWORD / TWITTER_EMAIL not set")
    await api.pool.add_account(username, password, email, email)
    await api.pool.login_all()


def _best_video_url(video: twscrape.MediaVideo) -> str:
    variants = sorted(video.variants, key=lambda v: v.bitrate, reverse=True)
    return variants[0].url if variants else ""


def _download_media(tweet_id: str, media: twscrape.Media, dest: Path) -> list[str]:
    paths: list[str] = []
    items: list[tuple[str, str]] = []
    for i, photo in enumerate(media.photos):
        # Strip query params for a clean extension
        url = photo.url.split("?")[0]
        ext = Path(url).suffix or ".jpg"
        items.append((photo.url, f"photo_{i}{ext}"))
    for i, video in enumerate(media.videos):
        url = _best_video_url(video)
        if url:
            items.append((url, f"video_{i}.mp4"))

    for url, name in items[:4]:  # max 4 per tweet
        out = dest / f"{tweet_id}_{name}"
        try:
            urllib.request.urlretrieve(url, out)  # noqa: S310
            paths.append(str(out))
        except Exception as exc:
            log.warning("failed to download %s: %s", url, exc)
    return paths


async def _fetch_async(handle: str) -> list[dict]:
    api = twscrape.API(str(_DB))
    await _ensure_logged_in(api)

    try:
        user = await api.user_by_login(handle)
    except Exception as exc:
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
            media_paths = _download_media(tw.id_str, tw.media, dest) if tw.media else []
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
    """Fetch recent tweets for one account. Returns tweets, newest first."""
    try:
        return asyncio.run(_fetch_async(handle))
    except Exception as exc:
        log.error("fetch_source failed for @%s: %s", handle, exc)
        return []
