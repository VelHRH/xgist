import asyncio
import os
import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, Mock, patch


try:
    import twscrape
except ModuleNotFoundError:
    twscrape = types.ModuleType("twscrape")
    twscrape.API = object
    twscrape.Media = object
    twscrape.MediaVideo = object
    sys.modules["twscrape"] = twscrape

from pipeline import fetch


class ViewerResponse:
    def __init__(self, payload=None, status_code=200, content=b""):
        self.payload = payload
        self.status_code = status_code
        self.content = content

    def json(self):
        return self.payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise fetch.requests.HTTPError(
                f"HTTP {self.status_code}", response=self)


class ProxyListResponse:
    def __init__(self, text, status_code=200):
        self.text = text
        self.status_code = status_code
        self.content = text.encode()
        self.headers = {"content-type": "text/plain"}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise fetch.requests.HTTPError(
                f"HTTP {self.status_code}", response=self)


class InvalidJsonResponse(ViewerResponse):
    def __init__(self, status_code=200):
        super().__init__(None, status_code)
        self.text = "not json"
        self.headers = {"content-type": "text/html"}

    def json(self):
        raise ValueError("invalid json")


def viewer_tweet(tweet_id, text, created_at, *, retweet=False, media=None,
                likes=0, retweets=0, replies=0):
    return {
        "id": tweet_id,
        "text": text,
        "createdAt": created_at,
        "author": {"handle": "alice"},
        "stats": {
            "likes": likes,
            "retweets": retweets,
            "replies": replies,
            "quotes": 0,
            "views": 0,
            "bookmarks": 0,
        },
        "media": media or [],
        "isQuote": False,
        "isRetweet": retweet,
    }


class FetchApiTest(unittest.IsolatedAsyncioTestCase):
    async def test_http_403_is_scraper_unavailable(self):
        api = Mock()
        api.user_by_login = AsyncMock(
            side_effect=Exception("HttpStatusError 403; queue=UserByScreenName"))

        with patch.object(fetch, "_get_api", AsyncMock(return_value=api)):
            with self.assertRaises(fetch.ScraperUnavailableError):
                await fetch._fetch_async("alice")

    async def test_cookie_api_uses_bounded_wait_and_requires_an_account(self):
        api = Mock()
        api.pool.add_account = AsyncMock()
        api.pool.login_all = AsyncMock()
        api_factory = Mock(return_value=api)
        cookies = "\n".join([
            "\t".join([".x.com", "TRUE", "/", "TRUE", "9999999999",
                          "auth_token", "auth-value"]),
            "\t".join([".x.com", "TRUE", "/", "TRUE", "9999999999",
                          "ct0", "ct0-value"]),
        ])

        with patch.object(fetch, "_api", None), \
                patch.object(fetch, "_cookie_str", ""), \
                patch.object(fetch.twscrape, "API", api_factory), \
                patch.dict(os.environ, {
                    "TWITTER_COOKIES": cookies,
                    "TWITTER_USERNAME": "xgist",
                }, clear=True):
            result = await fetch._get_api()

        self.assertIs(result, api)
        api_factory.assert_called_once_with(
            str(fetch._DB), raise_when_no_account=True, wait_timeout=30)
        api.pool.add_account.assert_awaited_once_with(
            username="xgist",
            password="n/a",
            email="n/a",
            email_password="",
            cookies="auth_token=auth-value; ct0=ct0-value",
        )
        api.pool.login_all.assert_awaited_once_with()

    async def test_proxy_strategy_requires_proxy_and_passes_it_to_twscrape(self):
        api = Mock()
        api.pool.add_account = AsyncMock()
        api.pool.login_all = AsyncMock()
        api_factory = Mock(return_value=api)

        with patch.object(fetch, "_api", None), \
                patch.object(fetch, "_cookie_str", ""), \
                patch.object(fetch.twscrape, "API", api_factory), \
                patch.dict(os.environ, {
                    "X_FETCH_STRATEGY": "x-proxy",
                    "TWS_PROXY": "http://proxy.example:8080",
                    "TWITTER_USERNAME": "xgist",
                    "TWITTER_COOKIES": "",
                    "TWITTER_PASSWORD": "password",
                    "TWITTER_EMAIL": "email@example.com",
                }, clear=True):
            await fetch._get_api()

        api_factory.assert_called_once_with(
            str(fetch._DB), raise_when_no_account=True, wait_timeout=30)
        self.assertEqual(api.pool.add_account.call_args.kwargs["proxy"],
                         "http://proxy.example:8080")

    async def test_proxy_strategy_requires_proxy_setting(self):
        with patch.object(fetch, "_api", None), \
                patch.dict(os.environ, {
                    "X_FETCH_STRATEGY": "x-proxy",
                    "TWS_PROXY": "",
                }, clear=True):
            with self.assertRaisesRegex(Exception, "TWS_PROXY"):
                await fetch._get_api()


class TwitterViewerFetchTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = TemporaryDirectory()
        self.tmp_path = Path(self.temp_dir.name)
        asyncio.set_event_loop(asyncio.new_event_loop())

    def tearDown(self):
        asyncio.get_event_loop().close()
        asyncio.set_event_loop(None)
        self.temp_dir.cleanup()

    def reset_free_proxy_state(self):
        for name in (
                "_free_proxy", "_free_proxies", "_free_proxy_pool",
                "_free_proxy_index", "_free_proxy_cache"):
            if not hasattr(fetch, name):
                continue
            value = getattr(fetch, name)
            if isinstance(value, list):
                value.clear()
            elif isinstance(value, dict):
                value.clear()
            elif isinstance(value, int):
                setattr(fetch, name, 0)
            else:
                setattr(fetch, name, None)

    def viewer_payload(self):
        return {
            "success": True,
            "data": {
                "user": {"handle": "alice", "protected": False},
                "tweets": [
                    viewer_tweet(
                        "old", "older", "Wed Sep 10 10:00:00 +0000 2026",
                        likes=2, retweets=1, replies=3,
                    ),
                    viewer_tweet(
                        "retweet", "RT @bob: skipped", "Thu Sep 11 12:00:00 +0000 2026",
                        retweet=True,
                    ),
                    viewer_tweet(
                        "new", "newer", "Thu Sep 11 13:00:00 +0000 2026",
                        media=[{
                            "type": "photo",
                            "url": "https://pbs.twimg.com/media/photo.jpg",
                            "videoUrl": "",
                        }],
                        likes=7, retweets=4, replies=5,
                    ),
                ],
            },
        }

    def test_default_strategy_reads_viewer_timeline_and_downloads_media(self):
        timeline = ViewerResponse(self.viewer_payload())
        media = ViewerResponse(content=b"photo-bytes")

        with patch.dict(os.environ, {}, clear=True), \
                patch.object(fetch, "TMP_DIR", self.tmp_path), \
                patch.object(fetch.curl_requests, "get",
                             return_value=timeline) as timeline_get, \
                patch.object(fetch.requests, "get", return_value=media):
            result = fetch.fetch_source("Alice")

        self.assertEqual([tweet["id"] for tweet in result], ["new", "old"])
        self.assertEqual(result[0]["text"], "newer")
        self.assertEqual(result[0]["favorites"], 7)
        self.assertEqual(result[0]["retweets"], 4)
        self.assertEqual(result[0]["replies"], 5)
        self.assertEqual(len(result[0]["media"]), 1)
        self.assertEqual(Path(result[0]["media"][0]).read_bytes(), b"photo-bytes")

        timeline_call = timeline_get.call_args
        self.assertIn("twitter-viewer.com/api/x/user-tweets", timeline_call.args[0])
        self.assertEqual(timeline_call.kwargs["params"]["username"], "alice")

    def test_viewer_strategy_uses_curl_cffi_browser_impersonation(self):
        payload = self.viewer_payload()
        payload["data"]["tweets"] = [payload["data"]["tweets"][2]]
        payload["data"]["tweets"][0]["media"] = []
        timeline = ViewerResponse(payload)

        with patch.dict(os.environ, {"X_FETCH_STRATEGY": "twitter-viewer"},
                        clear=True), \
                patch.object(fetch, "TMP_DIR", self.tmp_path), \
                patch.object(fetch.curl_requests, "get",
                             return_value=timeline) as get:
            result = fetch.fetch_source("Alice")

        self.assertEqual([tweet["id"] for tweet in result], ["new"])
        get.assert_called_once_with(
            "https://www.twitter-viewer.com/api/x/user-tweets",
            params={"username": "alice", "cursor": ""},
            headers={"User-Agent": "XGist/1.0"},
            timeout=30,
            impersonate="chrome",
        )

    def test_viewer_rate_limit_is_scraper_unavailable(self):
        with patch.dict(os.environ, {"X_FETCH_STRATEGY": "twitter-viewer"}), \
                patch.object(fetch.curl_requests, "get", return_value=ViewerResponse(
                    {"success": False, "error": "Too many requests"}, 429)):
            with self.assertRaises(fetch.ScraperUnavailableError):
                fetch.fetch_source("alice")

    def test_viewer_paginates_deduplicates_and_stops_at_fetch_range(self):
        first = self.viewer_payload()
        first["data"]["tweets"] = [first["data"]["tweets"][1],
                                     first["data"]["tweets"][2]]
        first["data"]["tweets"][1]["media"] = []
        first["data"]["pagination"] = {"hasMore": True, "nextCursor": "cursor-1"}
        second = self.viewer_payload()
        second["data"]["tweets"] = [
            second["data"]["tweets"][2],
            viewer_tweet("middle", "middle", "Thu Sep 11 12:30:00 +0000 2026"),
            viewer_tweet("last", "last", "Thu Sep 11 12:00:00 +0000 2026"),
        ]
        second["data"]["tweets"][0]["media"] = []
        second["data"]["pagination"] = {"hasMore": True, "nextCursor": "cursor-2"}

        with patch.dict(os.environ, {"X_FETCH_STRATEGY": "twitter-viewer"}), \
                patch.object(fetch, "FETCH_RANGE", 3), \
                patch.object(fetch.curl_requests, "get", side_effect=[
                    ViewerResponse(first), ViewerResponse(second),
                ]) as get:
            result = fetch.fetch_source("alice")

        self.assertEqual([tweet["id"] for tweet in result],
                         ["new", "middle", "last"])
        self.assertEqual(get.call_count, 2)
        self.assertEqual(get.call_args_list[0].kwargs["params"]["cursor"], "")
        self.assertEqual(get.call_args_list[1].kwargs["params"]["cursor"], "cursor-1")

    def test_viewer_forbidden_is_scraper_unavailable(self):
        with patch.dict(os.environ, {"X_FETCH_STRATEGY": "twitter-viewer"}), \
                patch.object(fetch.curl_requests, "get", return_value=ViewerResponse(
                    {"success": False, "error": "forbidden"}, 403)):
            with self.assertRaises(fetch.ScraperUnavailableError):
                fetch.fetch_source("alice")

    def test_free_proxy_strategy_fetches_and_reuses_one_valid_proxy(self):
        self.reset_free_proxy_state()
        proxy_list = ProxyListResponse(
            "invalid\n198.51.100.1:8080\n203.0.113.5:3128\n")
        responses = []

        def get(url, **kwargs):
            if "proxyscrape.com" in url:
                responses.append((url, kwargs))
                return proxy_list
            responses.append((url, kwargs))
            return ViewerResponse(self.viewer_payload())

        def requests_get(url, **kwargs):
            if "proxyscrape.com" in url:
                return get(url, **kwargs)
            return ViewerResponse(content=b"media")

        with patch.dict(os.environ,
                        {"X_FETCH_STRATEGY": "twitter-viewer-free-proxy"}), \
                patch.object(fetch.curl_requests, "get", side_effect=get), \
                patch.object(fetch.requests, "get", side_effect=requests_get), \
                patch.object(fetch, "TMP_DIR", self.tmp_path):
            first = fetch.fetch_source("alice")
            second = fetch.fetch_source("bob")

        self.assertTrue(first)
        self.assertTrue(second)
        proxy_calls = [kwargs for _, kwargs in responses
                       if "proxy" in kwargs]
        self.assertGreaterEqual(len(proxy_calls), 2)
        self.assertEqual(proxy_calls[0]["proxy"], proxy_calls[1]["proxy"])
        self.assertIn(proxy_calls[0]["proxy"], {
            "http://198.51.100.1:8080", "http://203.0.113.5:3128",
        })
        self.assertTrue(all(kwargs.get("impersonate") == "chrome"
                            for kwargs in proxy_calls))
        self.assertTrue(all(kwargs.get("verify", True)
                            for kwargs in proxy_calls))
        list_calls = [(url, kwargs) for url, kwargs in responses
                      if "proxyscrape.com" in url]
        self.assertEqual(len(list_calls), 1)
        url, kwargs = list_calls[0]
        query = kwargs.get("params", {})
        if query:
            self.assertEqual({key: str(value) for key, value in query.items()}, {
                "request": "getproxies",
                "protocol": "http",
                "ssl": "yes",
                "anonymity": "elite",
                "timeout": "3000",
                "country": "all",
            })
        else:
            for value in (
                    "request=getproxies", "protocol=http", "ssl=yes",
                    "anonymity=elite", "timeout=3000", "country=all"):
                self.assertIn(value, url)

    def test_free_proxy_strategy_rotates_after_viewer_failure(self):
        self.reset_free_proxy_state()
        proxy_list = ProxyListResponse(
            "198.51.100.1:8080\n203.0.113.5:3128\n")
        viewer_calls = []

        def get(url, **kwargs):
            if "proxyscrape.com" in url:
                return proxy_list
            viewer_calls.append(kwargs)
            if len(viewer_calls) == 1:
                return ViewerResponse({"success": False, "error": "blocked"}, 403)
            return ViewerResponse(self.viewer_payload())

        def requests_get(url, **kwargs):
            if "proxyscrape.com" in url:
                return get(url, **kwargs)
            return ViewerResponse(content=b"media")

        with patch.dict(os.environ,
                        {"X_FETCH_STRATEGY": "twitter-viewer-free-proxy"}), \
                patch.object(fetch.curl_requests, "get", side_effect=get), \
                patch.object(fetch.requests, "get", side_effect=requests_get), \
                patch.object(fetch, "TMP_DIR", self.tmp_path):
            result = fetch.fetch_source("alice")

        self.assertTrue(result)
        self.assertEqual(len(viewer_calls), 2)
        self.assertNotEqual(viewer_calls[0]["proxy"], viewer_calls[1]["proxy"])

    def test_free_proxy_strategy_does_not_rotate_for_not_found_or_protected(self):
        cases = [
            ({"success": False, "error": "User not found"}, 404, "missing"),
            ({"success": False, "error": "Account is protected"}, 403,
             "private"),
        ]
        for payload, status_code, handle in cases:
            with self.subTest(handle=handle):
                self.reset_free_proxy_state()
                proxy_list = ProxyListResponse(
                    "198.51.100.1:8080\n203.0.113.5:3128\n")
                viewer_calls = []

                def get(url, **kwargs):
                    if "proxyscrape.com" in url:
                        return proxy_list
                    viewer_calls.append(kwargs)
                    if len(viewer_calls) == 1:
                        return ViewerResponse(payload, status_code)
                    return ViewerResponse(self.viewer_payload())

                def requests_get(url, **kwargs):
                    if "proxyscrape.com" in url:
                        return get(url, **kwargs)
                    return ViewerResponse(content=b"media")

                with patch.dict(os.environ, {
                        "X_FETCH_STRATEGY": "twitter-viewer-free-proxy"}), \
                        patch.object(fetch.curl_requests, "get", side_effect=get), \
                        patch.object(fetch.requests, "get", side_effect=requests_get), \
                        patch.object(fetch, "TMP_DIR", self.tmp_path):
                    with self.assertRaises(fetch.SourceReadError):
                        fetch.fetch_source(handle)
                    result = fetch.fetch_source("alice")

                self.assertTrue(result)
                self.assertEqual(len(viewer_calls), 2)
                self.assertEqual(viewer_calls[0]["proxy"],
                                 viewer_calls[1]["proxy"])

    def test_free_proxy_strategy_fails_when_proxy_list_is_empty(self):
        self.reset_free_proxy_state()
        with patch.dict(os.environ,
                        {"X_FETCH_STRATEGY": "twitter-viewer-free-proxy"}), \
                patch.object(fetch.curl_requests, "get",
                             return_value=ProxyListResponse("\n")), \
                patch.object(fetch.requests, "get",
                             return_value=ProxyListResponse("\n")):
            with self.assertRaises(fetch.ScraperUnavailableError):
                fetch.fetch_source("alice")

    def test_free_proxy_strategy_attempts_at_most_five_proxies(self):
        self.reset_free_proxy_state()
        proxy_list = ProxyListResponse("\n".join(
            f"198.51.100.{i}:8080" for i in range(1, 8)))
        viewer_calls = []

        def get(url, **kwargs):
            if "proxyscrape.com" in url:
                return proxy_list
            viewer_calls.append(kwargs)
            return ViewerResponse({"success": False, "error": "blocked"}, 503)

        with patch.dict(os.environ,
                        {"X_FETCH_STRATEGY": "twitter-viewer-free-proxy"}), \
                patch.object(fetch.curl_requests, "get", side_effect=get), \
                patch.object(fetch.requests, "get", side_effect=get):
            with self.assertRaises(fetch.ScraperUnavailableError):
                fetch.fetch_source("alice")

        self.assertEqual(len(viewer_calls), 5)

    def test_free_proxy_strategy_rotates_on_network_rate_limit_and_bad_json(self):
        failures = [
            fetch.CurlRequestException("connection timeout"),
            ViewerResponse({"success": False, "error": "rate limited"}, 429),
            ViewerResponse({"success": False, "error": "upstream"}, 503),
            InvalidJsonResponse(),
        ]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                self.reset_free_proxy_state()
                proxy_list = ProxyListResponse(
                    "198.51.100.1:8080\n203.0.113.5:3128\n")
                viewer_calls = []

                def get(url, **kwargs):
                    if "proxyscrape.com" in url:
                        return proxy_list
                    viewer_calls.append(kwargs)
                    if len(viewer_calls) == 1:
                        if isinstance(failure, Exception):
                            raise failure
                        return failure
                    return ViewerResponse(self.viewer_payload())

                def requests_get(url, **kwargs):
                    if "proxyscrape.com" in url:
                        return get(url, **kwargs)
                    return ViewerResponse(content=b"media")

                with patch.dict(os.environ, {
                        "X_FETCH_STRATEGY": "twitter-viewer-free-proxy"}), \
                        patch.object(fetch.curl_requests, "get", side_effect=get), \
                        patch.object(fetch.requests, "get", side_effect=requests_get), \
                        patch.object(fetch, "TMP_DIR", self.tmp_path):
                    result = fetch.fetch_source("alice")

                self.assertTrue(result)
                self.assertEqual(len(viewer_calls), 2)
                self.assertNotEqual(viewer_calls[0]["proxy"],
                                    viewer_calls[1]["proxy"])

    def test_free_proxy_strategy_fails_when_proxy_list_request_is_unavailable(self):
        self.reset_free_proxy_state()
        failure = fetch.CurlRequestException("connection timeout")
        with patch.dict(os.environ,
                        {"X_FETCH_STRATEGY": "twitter-viewer-free-proxy"}), \
                patch.object(fetch.curl_requests, "get", side_effect=failure), \
                patch.object(fetch.requests, "get", side_effect=failure):
            with self.assertRaises(fetch.ScraperUnavailableError):
                fetch.fetch_source("alice")

    def test_viewer_missing_or_protected_source_is_source_read_error(self):
        cases = [
            ({"success": False, "error": "User not found"}, 404),
            ({"success": False, "error": "Account is protected"}, 403),
        ]
        for payload, status_code in cases:
            with self.subTest(payload=payload), \
                    patch.dict(os.environ, {"X_FETCH_STRATEGY": "twitter-viewer"}), \
                    patch.object(fetch.curl_requests, "get", return_value=ViewerResponse(
                        payload, status_code)):
                with self.assertRaises(fetch.SourceReadError):
                    fetch.fetch_source("alice")

    def test_x_direct_strategy_preserves_twscrape_fetch(self):
        api = Mock()
        api.user_by_login = AsyncMock(return_value=None)

        with patch.dict(os.environ, {"X_FETCH_STRATEGY": "x-direct"}), \
                patch.object(fetch, "_api", None), \
                patch.object(fetch, "_get_api", AsyncMock(return_value=api)):
            with self.assertRaises(fetch.SourceReadError):
                fetch.fetch_source("alice")

    def test_unknown_strategy_is_rejected(self):
        with patch.dict(os.environ, {"X_FETCH_STRATEGY": "unknown"}):
            with self.assertRaises(ValueError):
                fetch.fetch_source("alice")


if __name__ == "__main__":
    unittest.main()
