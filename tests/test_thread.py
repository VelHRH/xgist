import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

try:
    import twscrape
except ModuleNotFoundError:
    twscrape = types.ModuleType("twscrape")
    twscrape.API = object
    twscrape.Media = object
    twscrape.MediaVideo = object
    sys.modules["twscrape"] = twscrape

from pipeline import digest, thread


class ThreadChainTest(unittest.TestCase):
    def test_status_urls_accept_supported_hosts_prefixes_and_suffixes(self):
        urls = [
            "https://x.com/user/status/123",
            "https://www.twitter.com/user/status/123?ref=home",
            "https://mobile.x.com/user/status/123#post",
            "Text before https://twitter.com/user/status/123 and after",
        ]
        self.assertEqual([thread.parse_tweet_id(url) for url in urls],
                         ["123", "123", "123", "123"])
        self.assertIsNone(thread.parse_tweet_id("https://x.com/user"))

    def test_chain_stays_with_the_author_and_reconstructs_from_the_middle(self):
        pool = {
            "1": {"id": "1", "author": "alice", "in_reply_to": None,
                  "date": "2026-01-01T00:00:00"},
            "2": {"id": "2", "author": "alice", "in_reply_to": "1",
                  "date": "2026-01-01T00:01:00"},
            "3": {"id": "3", "author": "alice", "in_reply_to": "2",
                  "date": "2026-01-01T00:02:00"},
            "4": {"id": "4", "author": "bob", "in_reply_to": "2",
                  "date": "2026-01-01T00:03:00"},
        }
        self.assertEqual([item["id"] for item in thread.build_chain(pool, "2")],
                         ["1", "2", "3"])

    def test_replying_to_another_author_starts_at_the_linked_tweet(self):
        pool = {
            "1": {"id": "1", "author": "bob", "in_reply_to": None,
                  "date": "2026-01-01T00:00:00"},
            "2": {"id": "2", "author": "alice", "in_reply_to": "1",
                  "date": "2026-01-01T00:01:00"},
            "3": {"id": "3", "author": "alice", "in_reply_to": "2",
                  "date": "2026-01-01T00:02:00"},
        }
        self.assertEqual([item["id"] for item in thread.build_chain(pool, "2")],
                         ["2", "3"])


class ThreadDeliveryTest(unittest.TestCase):
    def test_paused_users_are_not_due(self):
        now = datetime(2026, 1, 1, 9, tzinfo=timezone.utc)
        config = {
            "paused": True,
            "sources": ["alice"],
            "hours": [9],
            "timezone": "UTC",
            "setup": {
                "timezone_confirmed_at": "2026-01-01T00:00:00+00:00",
                "digest_time_confirmed_at": "2026-01-01T00:00:00+00:00",
            },
        }
        self.assertIsNone(digest._due_slot(config, {}, now))

    def test_thread_preview_preserves_digest_state_and_needs_no_channel(self):
        state = {
            "last_run_hour": "2026-01-01 09",
            "last_digest_at": "2026-01-01T09:00:00+00:00",
            "proposed": ["old"],
            "pending": {},
        }
        saved = {}
        saved_users = {}
        controls = []
        media_limits = []
        item = {
            "id": "123", "source": "alice", "text": "Full thread",
            "media": ["one", "two"], "favorites": 8, "retweets": 3,
        }
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
                "os.environ", {"FORCE_USER": "7"}), patch.multiple(
                digest,
                TMP_DIR=Path(temp_dir) / "media",
                load_users=lambda: {"7": {
                    "channel": None,
                    "setup": {"completed_at": "2026-01-01T00:00:00+00:00"},
                }},
                load_state=lambda: {"7": state},
                fetch_thread=lambda url: item,
                prepare=lambda media, limit: media_limits.append(limit) or ["prepared"],
                make_caption=lambda value, config: "Clean post",
                save_user=lambda uid, value: saved_users.update({uid: value}),
                save_user_state=lambda uid, value: saved.update({uid: value}),
        ), patch.object(digest.tg, "send_preview",
                        lambda chat_id, media, caption: [{"message_id": 50}]), \
                patch.object(digest.tg, "send_controls",
                             lambda chat_id, ids, label: controls.append(label)), \
                patch.object(digest.tg, "media_refs", lambda messages: ["ref"]):
            digest.run_thread("https://x.com/alice/status/123")

        self.assertEqual(saved["7"]["last_run_hour"], "2026-01-01 09")
        self.assertEqual(saved["7"]["last_digest_at"],
                         "2026-01-01T09:00:00+00:00")
        self.assertEqual(saved["7"]["proposed"], ["old"])
        self.assertEqual(saved["7"]["pending"]["50"]["caption"], "Clean post")
        self.assertEqual(media_limits, [digest.THREAD_MEDIA_CAP])
        self.assertEqual(digest.THREAD_MEDIA_CAP, 10)
        self.assertIn("https://x.com/alice/status/123", controls[0])
        self.assertIn("❤️ 8", controls[0])
        self.assertIn("🔁 3", controls[0])
        self.assertIn("🧵", controls[0])
        self.assertIn("No Publishing channel connected yet", controls[0])
        self.assertIn("first_preview_delivered_at", saved_users["7"]["setup"])

    def test_failed_fetch_refunds_quota(self):
        refunded = []
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
                "os.environ", {"FORCE_USER": "7"}), patch.multiple(
                digest,
                TMP_DIR=Path(temp_dir) / "media",
                load_users=lambda: {"7": {}},
                fetch_thread=lambda url: (_ for _ in ()).throw(RuntimeError("bad")),
                refund_thread_quota=lambda uid: refunded.append(uid),
        ):
            digest.run_thread("https://x.com/alice/status/123")

        self.assertEqual(refunded, ["7"])


if __name__ == "__main__":
    unittest.main()
