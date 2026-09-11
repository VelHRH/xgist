import os
import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch


try:
    import twscrape
except ModuleNotFoundError:
    twscrape = types.ModuleType("twscrape")
    twscrape.API = object
    twscrape.Media = object
    twscrape.MediaVideo = object
    sys.modules["twscrape"] = twscrape

from pipeline import fetch, validate_account
from pipeline.fetch import _auth_failure


class ViewerResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def json(self):
        return self.payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise validate_account.requests.HTTPError(
                f"HTTP {self.status_code}", response=self)


class ProxyListResponse:
    def __init__(self, text, status_code=200):
        self.text = text
        self.status_code = status_code
        self.content = text.encode()
        self.headers = {"content-type": "text/plain"}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise validate_account.requests.HTTPError(
                f"HTTP {self.status_code}", response=self)


class FakeApi:
    def __init__(self, user=None, lookup_error=None, tweets=None, tweets_error=None):
        self.user = user
        self.lookup_error = lookup_error
        self.tweets = tweets or []
        self.tweets_error = tweets_error

    async def user_by_login(self, handle):
        if self.lookup_error:
            raise self.lookup_error
        return self.user

    async def user_tweets(self, user_id, limit):
        if self.tweets_error:
            raise self.tweets_error
        for tweet in self.tweets:
            yield tweet


class ValidateAccountTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
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

    async def outcome(self, api):
        with patch.dict(os.environ, {"X_FETCH_STRATEGY": "x-direct"}), \
                patch.object(fetch, "_get_api", AsyncMock(return_value=api)):
            return await validate_account.validate("naval")

    async def test_existing_public_account_is_readable_even_without_posts(self):
        result = await self.outcome(FakeApi(user=SimpleNamespace(id=1, protected=False)))
        self.assertEqual(result, "readable")

    async def test_missing_and_protected_accounts_are_distinct(self):
        self.assertEqual(await self.outcome(FakeApi()), "nonexistent")
        result = await self.outcome(
            FakeApi(user=SimpleNamespace(id=1, protected=True))
        )
        self.assertEqual(result, "protected")

    async def test_read_failures_distinguish_unreadable_and_transient(self):
        user = SimpleNamespace(id=1, protected=False)
        unreadable = await self.outcome(
            FakeApi(user=user, tweets_error=RuntimeError("unexpected response"))
        )
        transient = await self.outcome(
            FakeApi(user=user, tweets_error=RuntimeError("rate limit 429"))
        )
        self.assertEqual(unreadable, "unreadable")
        self.assertEqual(transient, "transient")

    async def test_default_strategy_validates_through_twitter_viewer(self):
        response = ViewerResponse({
            "success": True,
            "data": {
                "user": {"handle": "naval", "protected": False},
                "tweets": [],
            },
        })
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(fetch, "_get_api", AsyncMock(
                    side_effect=AssertionError("validation used twscrape"))), \
                patch.object(fetch.curl_requests, "get",
                             return_value=response):
            self.assertEqual(await validate_account.validate("naval"), "readable")

    async def test_viewer_protected_source_validates_as_protected(self):
        response = ViewerResponse({
            "success": False,
            "error": "Account is protected",
        }, 403)
        with patch.dict(os.environ, {"X_FETCH_STRATEGY": "twitter-viewer"}), \
                patch.object(fetch, "_get_api", AsyncMock(
                    side_effect=AssertionError("validation used twscrape"))), \
                patch.object(fetch.curl_requests, "get",
                             return_value=response):
            self.assertEqual(await validate_account.validate("naval"), "protected")

    async def test_free_proxy_strategy_validates_through_viewer_with_proxy(self):
        responses = []

        def get(url, **kwargs):
            responses.append((url, kwargs))
            if "proxyscrape.com" in url:
                return ProxyListResponse("198.51.100.1:8080\n")
            return ViewerResponse({
                "success": True,
                "data": {
                    "user": {"handle": "naval", "protected": False},
                    "tweets": [],
                },
            })

        def requests_get(url, **kwargs):
            if "proxyscrape.com" in url:
                return get(url, **kwargs)
            raise AssertionError("validation downloaded unexpected media")

        with patch.dict(os.environ,
                        {"X_FETCH_STRATEGY": "twitter-viewer-free-proxy"}), \
                patch.object(fetch, "_get_api", AsyncMock(
                    side_effect=AssertionError("validation used twscrape"))), \
                patch.object(fetch.curl_requests, "get", side_effect=get), \
                patch.object(fetch.requests, "get", side_effect=requests_get):
            self.assertEqual(await validate_account.validate("naval"), "readable")

        viewer_calls = [kwargs for url, kwargs in responses
                        if "twitter-viewer.com" in url]
        self.assertEqual(len(viewer_calls), 1)
        self.assertEqual(viewer_calls[0]["proxy"], "http://198.51.100.1:8080")

    async def test_free_proxy_strategy_reuses_proxy_for_validation_calls(self):
        responses = []

        def get(url, **kwargs):
            responses.append((url, kwargs))
            if "proxyscrape.com" in url:
                return ProxyListResponse("198.51.100.1:8080\n203.0.113.5:3128\n")
            return ViewerResponse({
                "success": True,
                "data": {
                    "user": {"handle": "naval", "protected": False},
                    "tweets": [],
                },
            })

        def requests_get(url, **kwargs):
            if "proxyscrape.com" in url:
                return get(url, **kwargs)
            raise AssertionError("validation downloaded unexpected media")

        with patch.dict(os.environ,
                        {"X_FETCH_STRATEGY": "twitter-viewer-free-proxy"}), \
                patch.object(fetch.curl_requests, "get", side_effect=get), \
                patch.object(fetch.requests, "get", side_effect=requests_get):
            self.assertEqual(await validate_account.validate("naval"), "readable")
            self.assertEqual(await validate_account.validate("another"), "readable")

        list_calls = [url for url, _ in responses if "proxyscrape.com" in url]
        viewer_calls = [kwargs for url, kwargs in responses
                        if "twitter-viewer.com" in url]
        self.assertEqual(len(list_calls), 1)
        self.assertEqual(len(viewer_calls), 2)
        self.assertEqual(viewer_calls[0]["proxy"], viewer_calls[1]["proxy"])


class FetchFailureClassificationTest(unittest.TestCase):
    def test_only_session_wide_403_failures_abort_all_sources(self):
        self.assertTrue(_auth_failure(RuntimeError("no active accounts")))
        self.assertTrue(_auth_failure(RuntimeError("403 session invalid")))
        self.assertTrue(_auth_failure(RuntimeError("403 auth_token expired")))
        self.assertFalse(_auth_failure(RuntimeError("403 protected account")))
        self.assertFalse(_auth_failure(RuntimeError("403 not authorized")))


class ValidateAccountMainTest(unittest.TestCase):
    def test_result_is_posted_to_the_signed_worker_webhook(self):
        response = Mock()
        response.raise_for_status = Mock()
        with patch.dict(os.environ, {
            "ACCOUNT_HANDLE": "Naval",
            "FORCE_USER": "123",
            "WORKER_URL": "https://worker.test",
            "WEBHOOK_SECRET": "secret",
            "X_FETCH_STRATEGY": "x-direct",
        }), patch.object(fetch, "_get_api", AsyncMock(return_value=
                FakeApi(user=SimpleNamespace(id=1, protected=False)))), \
                patch.object(validate_account.requests, "post", return_value=response) as post:
            validate_account.main()

        post.assert_called_once_with(
            "https://worker.test",
            json={"account_validation": {
                "chat_id": "123", "handle": "naval", "outcome": "readable",
            }},
            headers={"x-telegram-bot-api-secret-token": "secret"},
            timeout=30,
        )
        response.raise_for_status.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
