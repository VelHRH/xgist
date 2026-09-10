"""Fetch recent tweets and threads from X."""

import asyncio
import logging
import os
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlparse

import requests
import twscrape

from .config import FETCH_RANGE, THREAD_MEDIA_CAP, TMP_DIR
from .thread import build_chain, parse_tweet_id

log = logging.getLogger(__name__)

_DB = Path("accounts.db")
_api: twscrape.API | None = None
_api_proxy: str | None = None
_cookie_str: str = ""
_VIEWER_URL = "https://www.twitter-viewer.com/api/x"
_VIEWER_HEADERS = {"User-Agent": "XGist/1.0"}


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


async def _get_api(proxy: str | None = None) -> twscrape.API:
    global _api, _api_proxy, _cookie_str
    if proxy is None and os.getenv("X_FETCH_STRATEGY", "").strip().lower() == "x-proxy":
        proxy = os.getenv("TWS_PROXY", "").strip()
        if not proxy:
            raise ValueError("X_FETCH_STRATEGY=x-proxy requires TWS_PROXY")
    if _api is not None and _api_proxy == proxy:
        return _api

    api = twscrape.API(
        str(_DB),
        raise_when_no_account=True,
        wait_timeout=30,
    )
    cookies_raw = os.environ.get("TWITTER_COOKIES", "")
    username = os.environ.get("TWITTER_USERNAME", "xgist")

    if cookies_raw:
        _cookie_str = _parse_cookies(cookies_raw)
        account = {
            "username": username,
            "password": "n/a",
            "email": "n/a",
            "email_password": "",
            "cookies": _cookie_str,
        }
        if proxy:
            account["proxy"] = proxy
        await api.pool.add_account(**account)
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
        if proxy:
            await api.pool.add_account(username, password, email, email,
                                       proxy=proxy)
        else:
            await api.pool.add_account(username, password, email, email)
        await api.pool.login_all()

    _api = api
    _api_proxy = proxy
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


class SourceReadError(Exception):
    pass


class ScraperUnavailableError(Exception):
    pass


def _auth_failure(exc: Exception) -> bool:
    message = str(exc).lower()
    if "no active accounts" in message:
        return True
    return "403" in message and any(value in message for value in (
        "session", "cookie", "login", "auth_token",
    ))


def _scraper_unavailable(exc: Exception) -> bool:
    message = str(exc).lower()
    return "403" in message or "no account available" in message


async def _fetch_async(handle: str, proxy: str | None = None) -> list[dict]:
    api = await _get_api(proxy)
    try:
        user = await api.user_by_login(handle)
    except Exception as exc:
        if _auth_failure(exc):
            raise AuthError(f"session invalid for @{handle}: {exc}") from exc
        if _scraper_unavailable(exc):
            raise ScraperUnavailableError(
                f"scraper unavailable while resolving @{handle}: {exc}") from exc
        raise SourceReadError(f"could not resolve @{handle}: {exc}") from exc
    if user is None:
        raise SourceReadError(f"@{handle} not found")

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
        if _auth_failure(exc):
            raise AuthError(f"session invalid for @{handle}: {exc}") from exc
        if _scraper_unavailable(exc):
            raise ScraperUnavailableError(
                f"scraper unavailable while fetching @{handle}: {exc}") from exc
        raise SourceReadError(f"error fetching @{handle}: {exc}") from exc

    tweets.sort(key=lambda t: t["date"], reverse=True)
    return tweets


def _fetch_with_twscrape(handle: str, proxy: str | None = None) -> list[dict]:
    try:
        return asyncio.get_event_loop().run_until_complete(_fetch_async(handle, proxy))
    except AuthError:
        raise
    except ScraperUnavailableError:
        raise
    except SourceReadError:
        raise
    except Exception as exc:
        if _auth_failure(exc):
            raise AuthError(f"session invalid for @{handle}: {exc}") from exc
        if _scraper_unavailable(exc):
            raise ScraperUnavailableError(
                f"scraper unavailable for @{handle}: {exc}") from exc
        log.error("fetch_source failed for @%s: %s", handle, exc)
        return []


def _viewer_error(handle: str, response: requests.Response,
                  payload: dict | None) -> None:
    message = str((payload or {}).get("error") or f"HTTP {response.status_code}")
    lowered = message.lower()
    if response.status_code == 404 or "not found" in lowered or "does not exist" in lowered:
        raise SourceReadError(f"@{handle} not found: {message}")
    if "protected" in lowered or "private" in lowered:
        raise SourceReadError(f"@{handle} is protected: {message}")
    if response.status_code in (401, 403, 429) or response.status_code >= 500:
        raise ScraperUnavailableError(
            f"twitter-viewer unavailable while fetching @{handle}: {message}")
    if response.status_code >= 400 or not (payload or {}).get("success"):
        raise SourceReadError(f"could not read @{handle}: {message}")


def _viewer_page(handle: str, cursor: str = "") -> dict:
    worker_url = os.getenv("WORKER_URL", "").rstrip("/")
    webhook_secret = os.getenv("WEBHOOK_SECRET", "")
    url = (f"{worker_url}/x-viewer/user-tweets"
           if worker_url and webhook_secret
           else f"{_VIEWER_URL}/user-tweets")
    headers = dict(_VIEWER_HEADERS)
    if worker_url and webhook_secret:
        headers["x-telegram-bot-api-secret-token"] = webhook_secret
    try:
        response = requests.get(
            url,
            params={"username": handle.lower(), "cursor": cursor},
            headers=headers,
            timeout=30,
        )
    except requests.RequestException as exc:
        raise ScraperUnavailableError(
            f"twitter-viewer unavailable while fetching @{handle}: {exc}") from exc
    try:
        payload = response.json()
    except ValueError as exc:
        detail = response.text[:200].replace("\n", " ")
        raise ScraperUnavailableError(
            f"twitter-viewer returned HTTP {response.status_code} "
            f"{response.headers.get('content-type', '')!r} for @{handle}: "
            f"{detail}") from exc
    if not isinstance(payload, dict):
        raise ScraperUnavailableError(
            f"twitter-viewer returned invalid data for @{handle}")
    if response.status_code >= 400 or not payload.get("success"):
        _viewer_error(handle, response, payload)
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("tweets"), list):
        raise ScraperUnavailableError(
            f"twitter-viewer returned invalid data for @{handle}")
    return data


def _download_viewer_media(tweet_id: str, media: list[dict],
                           dest: Path) -> list[str]:
    items: list[tuple[str, str]] = []
    for i, item in enumerate(media):
        if not isinstance(item, dict):
            continue
        if item.get("type") == "photo" and item.get("url"):
            url = item["url"].split("?")[0] + "?format=jpg&name=large"
            if urlparse(url).hostname == "pbs.twimg.com":
                items.append((url, f"photo_{i}.jpg"))
        elif item.get("videoUrl"):
            url = item["videoUrl"]
            if urlparse(url).hostname == "video.twimg.com":
                items.append((url, f"video_{i}.mp4"))

    paths: list[str] = []
    for url, name in items[:4]:
        out = dest / f"{tweet_id}_{name}"
        try:
            response = requests.get(url, headers=_DL_HEADERS, timeout=60)
            response.raise_for_status()
            out.write_bytes(response.content)
            paths.append(str(out))
        except Exception as exc:
            log.warning("failed to download %s: %s", url, exc)
    return paths


def _fetch_with_viewer(handle: str) -> list[dict]:
    dest = TMP_DIR / handle.lower()
    dest.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []
    seen: set[str] = set()
    cursor = ""
    pages = 0
    max_pages = max(1, (FETCH_RANGE + 19) // 20 + 2)

    while len(rows) < FETCH_RANGE and pages < max_pages:
        data = _viewer_page(handle, cursor)
        pages += 1
        user = data.get("user") or {}
        if user.get("protected"):
            raise SourceReadError(f"@{handle} is protected")
        for item in data["tweets"]:
            tweet_id = str(item.get("id") or "")
            if not tweet_id or tweet_id in seen or item.get("isRetweet"):
                continue
            try:
                date = parsedate_to_datetime(item["createdAt"])
            except (KeyError, TypeError, ValueError) as exc:
                raise ScraperUnavailableError(
                    f"twitter-viewer returned an invalid date for @{handle}") from exc
            seen.add(tweet_id)
            stats = item.get("stats") or {}
            media_paths = _download_viewer_media(
                tweet_id, item.get("media") or [], dest)
            rows.append({
                "id": tweet_id,
                "source": handle.lower(),
                "text": item.get("text") or "",
                "date": date,
                "favorites": stats.get("likes") or 0,
                "retweets": stats.get("retweets") or 0,
                "replies": stats.get("replies") or 0,
                "media": media_paths,
            })
            if len(rows) >= FETCH_RANGE:
                break
        pagination = data.get("pagination") or {}
        next_cursor = pagination.get("nextCursor")
        if not pagination.get("hasMore") or not next_cursor or next_cursor == cursor:
            break
        cursor = next_cursor

    rows.sort(key=lambda tweet: tweet["date"], reverse=True)
    return rows[:FETCH_RANGE]


class XDataStrategy:
    def fetch_source(self, handle: str) -> list[dict]:
        raise NotImplementedError

    async def validate(self, handle: str) -> str:
        raise NotImplementedError


class DirectXStrategy(XDataStrategy):
    def fetch_source(self, handle: str) -> list[dict]:
        return _fetch_with_twscrape(handle)

    async def validate(self, handle: str) -> str:
        return await _validate_with_twscrape(handle)


class ProxyXStrategy(XDataStrategy):
    def __init__(self) -> None:
        self.proxy = os.getenv("TWS_PROXY", "").strip()
        if not self.proxy:
            raise ValueError("X_FETCH_STRATEGY=x-proxy requires TWS_PROXY")

    def fetch_source(self, handle: str) -> list[dict]:
        return _fetch_with_twscrape(handle, self.proxy)

    async def validate(self, handle: str) -> str:
        return await _validate_with_twscrape(handle, self.proxy)


class TwitterViewerStrategy(XDataStrategy):
    def fetch_source(self, handle: str) -> list[dict]:
        return _fetch_with_viewer(handle)

    async def validate(self, handle: str) -> str:
        try:
            data = _viewer_page(handle)
            if (data.get("user") or {}).get("protected"):
                return "protected"
            return "readable"
        except SourceReadError as exc:
            message = str(exc).lower()
            if "not found" in message or "does not exist" in message:
                return "nonexistent"
            if "protected" in message or "private" in message:
                return "protected"
            return "unreadable"
        except ScraperUnavailableError:
            return "transient"


def _strategy() -> XDataStrategy:
    name = os.getenv("X_FETCH_STRATEGY", "twitter-viewer").strip().lower()
    strategies = {
        "twitter-viewer": TwitterViewerStrategy,
        "x-direct": DirectXStrategy,
        "x-proxy": ProxyXStrategy,
    }
    if name not in strategies:
        choices = ", ".join(strategies)
        raise ValueError(f"unknown X_FETCH_STRATEGY {name!r}; choose {choices}")
    return strategies[name]()


def fetch_source(handle: str) -> list[dict]:
    return _strategy().fetch_source(handle)


async def validate_source(handle: str) -> str:
    return await _strategy().validate(handle)


async def _validate_with_twscrape(handle: str,
                                  proxy: str | None = None) -> str:
    api = await _get_api(proxy)
    user = await api.user_by_login(handle)
    if user is None:
        return "nonexistent"
    if getattr(user, "protected", False):
        return "protected"
    async for _ in api.user_tweets(user.id, limit=1):
        break
    return "readable"


def _thread_tweet_dict(tw: "twscrape.Tweet") -> dict:
    """A tweet dict for thread assembly. `_media` carries the twscrape media
    object for later download; build_chain never reads it (it stays a pure
    function over id/author/in_reply_to/date)."""
    return {
        "id": tw.id_str,
        "author": (tw.user.username if tw.user else "").lstrip("@"),
        "text": tw.rawContent or "",
        "date": tw.date,
        "favorites": tw.likeCount or 0,
        "retweets": tw.retweetCount or 0,
        "in_reply_to": tw.inReplyToTweetIdStr,
        "_media": tw.media,
    }


async def _fetch_thread_async(url: str) -> dict:
    tid = parse_tweet_id(url)
    if not tid:
        raise ValueError(f"not a tweet URL: {url!r}")
    strategy = os.getenv("X_FETCH_STRATEGY", "twitter-viewer").strip().lower()
    proxy = (None if strategy == "x-direct"
             else os.getenv("TWS_PROXY", "").strip() or None)
    if strategy == "x-proxy" and not proxy:
        raise ValueError("X_FETCH_STRATEGY=x-proxy requires TWS_PROXY")
    api = await _get_api(proxy)

    linked = await api.tweet_details(int(tid))
    if linked is None:
        raise RuntimeError(f"tweet {tid} not found (deleted, protected, or invalid)")

    # tweet_details gives us the linked tweet; tweet_thread fills in the rest of
    # the conversation so build_chain can walk the author's self-reply chain.
    pool: dict[str, dict] = {}
    linked_d = _thread_tweet_dict(linked)
    pool[linked_d["id"]] = linked_d
    try:
        async for tw in api.tweet_thread(int(tid), limit=-1):
            d = _thread_tweet_dict(tw)
            pool.setdefault(d["id"], d)
    except Exception as exc:
        # A partial thread still yields a usable chain around the linked tweet.
        log.warning("tweet_thread incomplete for %s: %s", tid, exc)

    chain = build_chain(pool, linked_d["id"])
    root = chain[0]
    author = linked_d["author"]

    # Gather media across the chain in thread order, capped at THREAD_MEDIA_CAP.
    dest = TMP_DIR / f"thread_{tid}"
    dest.mkdir(parents=True, exist_ok=True)
    media_paths: list[str] = []
    for t in chain:
        if t.get("_media"):
            media_paths += _download_media(t["id"], t["_media"], dest, _cookie_str)
        if len(media_paths) >= THREAD_MEDIA_CAP:
            break
    media_paths = media_paths[:THREAD_MEDIA_CAP]

    text = "\n\n".join(t["text"] for t in chain if t["text"]).strip()
    return {
        "id": root["id"],
        "source": author,
        "text": text,
        "favorites": root["favorites"],
        "retweets": root["retweets"],
        "media": media_paths,
    }


def fetch_thread(url: str) -> dict:
    """Resolve a tweet link into a single thread-post dict: the author's
    self-reply chain concatenated (`text`), its media gathered in order
    (`media`, capped), and the root tweet's id/handle/engagement for the
    control line. Raises on any failure (invalid/deleted tweet, scraper
    outage) so the caller can refund the user's quota."""
    return asyncio.get_event_loop().run_until_complete(_fetch_thread_async(url))
