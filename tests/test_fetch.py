import os
import sys
import types
import unittest
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


if __name__ == "__main__":
    unittest.main()
