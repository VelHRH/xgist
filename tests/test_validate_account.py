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

from pipeline import validate_account
from pipeline.fetch import _auth_failure


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
    async def outcome(self, api):
        with patch.object(validate_account, "_get_api", AsyncMock(return_value=api)):
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
        }), patch.object(validate_account, "_get_api", AsyncMock(return_value=
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
