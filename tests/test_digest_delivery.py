import copy
import os
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
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

from pipeline import digest, tg


def tweet(created_at):
    return {
        "id": "tweet-1",
        "source": "alice",
        "date": created_at,
        "favorites": 20,
        "retweets": 4,
        "replies": 2,
        "media": [],
        "text": "A useful post that is long enough to become a private Preview.",
    }


class DigestHarness:
    def __init__(self, users, state, fetched):
        self.users = users
        self.state = state
        self.fetched = fetched
        self.events = []
        self.next_message_id = 1

    def send_preview(self, chat_id, media, caption):
        self.events.append(("preview", chat_id, caption))
        message = {"message_id": self.next_message_id}
        self.next_message_id += 1
        return [message]

    def send_controls(self, chat_id, content_ids, label):
        self.events.append(("controls", chat_id, label))

    def send_text(self, chat_id, text):
        self.events.append(("text", chat_id, text))

    def save_state(self, uid, value):
        self.state[uid] = copy.deepcopy(value)

    def run(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.dict(os.environ, {
                "ADMIN_ID": "",
                "FORCE_ALL": "1",
                "FORCE_USER": "",
                "THREAD_URL": "",
            }), patch.multiple(
                digest,
                TMP_DIR=Path(temp_dir) / "media",
                load_users=lambda: copy.deepcopy(self.users),
                load_whitelist=lambda: [],
                load_promo=lambda: [],
                load_state=lambda: self.state,
                load_feedback=lambda: {},
                fetch_source=lambda source: copy.deepcopy(self.fetched[source]),
                prepare=lambda media: [],
                make_caption=lambda item, cfg: "Prepared caption",
                pick_top=lambda candidates, cfg: candidates,
                save_user_state=self.save_state,
            ), patch.object(digest.tg, "send_preview", self.send_preview), \
                    patch.object(digest.tg, "send_controls", self.send_controls), \
                    patch.object(digest.tg, "send_text", self.send_text), \
                    patch.object(digest.tg, "media_refs", lambda messages: []):
                digest.main()


class DigestDeliveryTest(unittest.TestCase):
    def test_channel_optional_delivery_and_pro_briefing(self):
        now = datetime.now(timezone.utc)
        paid_until = (now + timedelta(days=10)).isoformat()
        harness = DigestHarness(
            users={
                "1": {"channel": "@news", "sources": ["alice"], "hours": [9]},
                "2": {"channel": None, "sources": ["alice"], "hours": [9]},
                "3": {
                    "channel": None,
                    "sources": ["alice"],
                    "hours": [9],
                    "paid_until": paid_until,
                    "pro_source": "paid",
                },
            },
            state={},
            fetched={"alice": [tweet(now - timedelta(hours=1))]},
        )

        harness.run()

        previews = [event for event in harness.events if event[0] == "preview"]
        self.assertEqual([(event[1], event[2]) for event in previews], [
            (1, "Prepared caption"),
            (2, "Prepared caption"),
            (3, "Prepared caption"),
        ])

        controls = {
            event[1]: event[2] for event in harness.events if event[0] == "controls"
        }
        self.assertIn("Publish to @news?", controls[1])
        self.assertIn("No Publishing channel connected yet", controls[2])
        self.assertIn("Tap ✅ Post when you're ready to connect one", controls[2])
        self.assertNotIn("Publish to your channel", controls[2])
        self.assertNotIn("XGist Pro", controls[3])
        self.assertNotIn("⭐", controls[3])

        pro_events = [event for event in harness.events if event[1] == 3]
        self.assertEqual([event[0] for event in pro_events],
                         ["text", "preview", "controls"])
        self.assertIn("⭐ <b>XGist Pro</b>", pro_events[0][2])
        self.assertIn("curated from 1 watched account", pro_events[0][2])

    def test_only_the_first_empty_digest_is_acknowledged(self):
        now = datetime.now(timezone.utc)
        harness = DigestHarness(
            users={"1": {"channel": None, "sources": ["alice"], "hours": [9]}},
            state={},
            fetched={"alice": [tweet(now - timedelta(hours=30))]},
        )

        harness.run()

        texts = [event[2] for event in harness.events if event[0] == "text"]
        self.assertEqual(len(texts), 1)
        self.assertIn("Your first briefing is complete", texts[0])
        self.assertIn("Nothing strong enough to recommend this time", texts[0])
        self.assertIn("last_digest_at", harness.state["1"])

        harness.events.clear()
        harness.run()
        self.assertEqual(harness.events, [])

    def test_notify_empty_preserves_later_empty_messages(self):
        now = datetime.now(timezone.utc)
        harness = DigestHarness(
            users={
                "1": {
                    "channel": None,
                    "sources": ["alice"],
                    "hours": [9],
                    "notify_empty": True,
                },
            },
            state={"1": {"last_digest_at": (now - timedelta(days=1)).isoformat()}},
            fetched={"alice": [tweet(now - timedelta(hours=30))]},
        )

        harness.run()

        self.assertEqual(harness.events, [
            ("text", 1, "Nothing new from your sources in the window."),
        ])

    def test_send_text_uses_html_for_briefing_identity(self):
        with patch.object(tg, "call") as call:
            tg.send_text(1, "⭐ <b>XGist Pro</b>")
        call.assert_called_once_with(
            "sendMessage", chat_id=1, text="⭐ <b>XGist Pro</b>",
            parse_mode="HTML")


if __name__ == "__main__":
    unittest.main()
