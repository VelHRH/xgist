import copy
import json
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


def timezone_confirmed(config):
    return {
        **config,
        "setup": {
            "timezone_confirmed_at": "2026-01-01T00:00:00+00:00",
            "digest_time_confirmed_at": "2026-01-01T00:00:00+00:00",
        },
    }


class DigestHarness:
    def __init__(self, users, state, fetched, preview_error=False):
        self.users = users
        self.state = state
        self.fetched = fetched
        self.preview_error = preview_error
        self.events = []
        self.user_saves = []
        self.fetched_sources = []
        self.next_message_id = 1

    def fetch_source(self, source):
        self.fetched_sources.append(source)
        result = self.fetched[source]
        if isinstance(result, Exception):
            raise result
        return copy.deepcopy(result)

    def send_preview(self, chat_id, media, caption):
        if self.preview_error:
            raise RuntimeError("Preview delivery failed")
        self.events.append(("preview", chat_id, caption))
        message = {"message_id": self.next_message_id}
        self.next_message_id += 1
        return [message]

    def send_controls(self, chat_id, content_ids, label):
        self.events.append(("controls", chat_id, label))

    def send_text(self, chat_id, text):
        self.events.append(("text", chat_id, text))

    def send_account_attention(self, chat_id, handle):
        self.events.append(("attention", chat_id, handle))

    def save_state(self, uid, value):
        self.state[uid] = copy.deepcopy(value)

    def save_user(self, uid, value):
        saved = copy.deepcopy(value)
        self.users[uid] = saved
        self.user_saves.append((uid, saved))

    def run(self, force_user=""):
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.dict(os.environ, {
                "ADMIN_ID": "",
                "FORCE_ALL": "1",
                "FORCE_USER": force_user,
                "THREAD_URL": "",
            }), patch.multiple(
                digest,
                TMP_DIR=Path(temp_dir) / "media",
                load_users=lambda: copy.deepcopy(self.users),
                load_whitelist=lambda: [],
                load_promo=lambda: [],
                load_state=lambda: self.state,
                load_feedback=lambda: {},
                fetch_source=self.fetch_source,
                prepare=lambda media: [],
                make_caption=lambda item, cfg: "Prepared caption",
                pick_top=lambda candidates, cfg: candidates,
                save_user=self.save_user,
                save_user_state=self.save_state,
            ), patch.object(digest.tg, "send_preview", self.send_preview), \
                    patch.object(digest.tg, "send_controls", self.send_controls), \
                    patch.object(digest.tg, "send_text", self.send_text), \
                    patch.object(digest.tg, "send_account_attention",
                                 self.send_account_attention), \
                    patch.object(digest.tg, "media_refs", lambda messages: []):
                digest.main()


class DigestDeliveryTest(unittest.TestCase):
    def test_all_source_failures_leave_slot_and_account_health_unchanged(self):
        now = datetime.now(timezone.utc)
        previous_state = {
            "last_run_hour": "2026-08-24 09",
            "last_digest_at": (now - timedelta(days=1)).isoformat(),
        }
        harness = DigestHarness(
            users={"1": timezone_confirmed({
                "channel": None,
                "sources": ["alice", "bob"],
                "hours": [9],
            })},
            state={"1": copy.deepcopy(previous_state)},
            fetched={
                "alice": digest.SourceReadError("unreadable"),
                "bob": digest.SourceReadError("unreadable"),
            },
        )

        harness.run()

        self.assertEqual(harness.state["1"], previous_state)
        self.assertNotIn("account_health", harness.users["1"])
        self.assertEqual(harness.events, [])

    def test_single_source_failure_updates_account_health(self):
        harness = DigestHarness(
            users={"1": timezone_confirmed({
                "channel": None,
                "sources": ["alice"],
                "hours": [9],
            })},
            state={},
            fetched={"alice": digest.SourceReadError("unreadable")},
        )

        harness.run()

        self.assertEqual(
            harness.users["1"]["account_health"]["alice"]["consecutive_failures"], 1)
        self.assertIn("last_run_hour", harness.state["1"])

    def test_account_health_recovers_before_attention(self):
        now = datetime.now(timezone.utc)
        harness = DigestHarness(
            users={"1": timezone_confirmed({
                "channel": None,
                "sources": ["broken", "alice"],
                "hours": [9],
            })},
            state={},
            fetched={
                "broken": digest.SourceReadError("temporarily unreadable"),
                "alice": [tweet(now - timedelta(hours=1))],
            },
        )

        harness.run()
        self.assertEqual(
            harness.users["1"]["account_health"]["broken"]["consecutive_failures"], 1)
        self.assertNotIn("needs_attention",
                         harness.users["1"]["account_health"]["broken"])
        self.assertIn(("preview", 1, "Prepared caption"), harness.events)

        harness.run()
        self.assertEqual(
            harness.users["1"]["account_health"]["broken"]["consecutive_failures"], 2)
        self.assertNotIn("needs_attention",
                         harness.users["1"]["account_health"]["broken"])
        self.assertFalse(any(event[0] == "attention" for event in harness.events))

        harness.fetched["broken"] = []
        harness.run()
        self.assertNotIn("account_health", harness.users["1"])
        self.assertEqual(harness.users["1"]["sources"], ["broken", "alice"])

    def test_third_failure_marks_attention_and_notifies_once(self):
        now = datetime.now(timezone.utc)
        harness = DigestHarness(
            users={"1": timezone_confirmed({
                "channel": None,
                "sources": ["broken", "alice"],
                "hours": [9],
            })},
            state={},
            fetched={
                "broken": digest.SourceReadError("unreadable"),
                "alice": [tweet(now - timedelta(hours=1))],
            },
        )

        for _ in range(3):
            harness.run()

        health = harness.users["1"]["account_health"]["broken"]
        self.assertEqual(health["consecutive_failures"], 3)
        self.assertTrue(health["needs_attention"])
        self.assertIn("attention_notified_at", health)
        self.assertEqual(
            [event for event in harness.events if event[0] == "attention"],
            [("attention", 1, "broken")])
        self.assertEqual(harness.users["1"]["sources"], ["broken", "alice"])

        harness.run()
        self.assertEqual(
            [event for event in harness.events if event[0] == "attention"],
            [("attention", 1, "broken")])
        self.assertEqual(
            harness.users["1"]["account_health"]["broken"]["consecutive_failures"], 4)

        harness.fetched["broken"] = []
        harness.run()
        self.assertNotIn("account_health", harness.users["1"])

    def test_shared_fetch_updates_each_users_account_health_independently(self):
        now = datetime.now(timezone.utc)
        harness = DigestHarness(
            users={
                "1": timezone_confirmed({
                    "channel": None,
                    "sources": ["broken", "alice"],
                    "hours": [9],
                    "account_health": {
                        "broken": {"consecutive_failures": 1},
                    },
                }),
                "2": timezone_confirmed({
                    "channel": None,
                    "sources": ["broken", "alice"],
                    "hours": [9],
                    "account_health": {
                        "broken": {"consecutive_failures": 2},
                    },
                }),
            },
            state={},
            fetched={
                "broken": digest.SourceReadError("unreadable"),
                "alice": [tweet(now - timedelta(hours=1))],
            },
        )

        harness.run()

        self.assertEqual(harness.fetched_sources.count("broken"), 1)
        self.assertEqual(
            harness.users["1"]["account_health"]["broken"]["consecutive_failures"], 2)
        self.assertNotIn("needs_attention",
                         harness.users["1"]["account_health"]["broken"])
        self.assertEqual(
            harness.users["2"]["account_health"]["broken"]["consecutive_failures"], 3)
        self.assertTrue(harness.users["2"]["account_health"]["broken"]["needs_attention"])
        self.assertEqual(
            [event for event in harness.events if event[0] == "attention"],
            [("attention", 2, "broken")])

    def test_inactive_retained_digest_time_is_not_due(self):
        config = timezone_confirmed({
            "channel": None,
            "sources": ["alice"],
            "hours": [12, 18],
            "free_active_sources": ["alice"],
            "free_active_hours": [18],
            "timezone": "UTC",
        })
        noon = datetime(2026, 8, 18, 12, tzinfo=timezone.utc)
        evening = datetime(2026, 8, 18, 18, tzinfo=timezone.utc)
        plan = digest.resolve_plan("1", config, [], [], "99", noon)
        applied = digest.apply_plan(config, plan)

        with patch.dict(os.environ, {"FORCE_ALL": ""}):
            self.assertIsNone(digest._due_slot(applied, {}, noon))
            self.assertEqual(digest._due_slot(applied, {}, evening),
                             "2026-08-18 18")

    def test_free_digest_fetches_only_selected_active_accounts(self):
        now = datetime.now(timezone.utc)
        active = ["one", "three", "four", "six", "seven"]
        harness = DigestHarness(
            users={
                "1": timezone_confirmed({
                    "channel": None,
                    "sources": ["zero", "one", "two", "three", "four", "five", "six", "seven"],
                    "hours": [7, 12, 18],
                    "free_active_sources": active,
                    "free_active_hours": [18],
                }),
            },
            state={},
            fetched={source: [tweet(now - timedelta(hours=1))] for source in active},
        )

        harness.run()

        self.assertEqual(sorted(harness.fetched_sources), sorted(active))
        self.assertNotIn("zero", harness.fetched_sources)
        self.assertNotIn("two", harness.fetched_sources)
        self.assertNotIn("five", harness.fetched_sources)

    def test_channel_optional_delivery_and_pro_briefing(self):
        now = datetime.now(timezone.utc)
        paid_until = (now + timedelta(days=10)).isoformat()
        harness = DigestHarness(
            users={
                "1": timezone_confirmed(
                    {"channel": "@news", "sources": ["alice"], "hours": [9]}),
                "2": timezone_confirmed(
                    {"channel": None, "sources": ["alice"], "hours": [9]}),
                "3": timezone_confirmed({
                    "channel": None,
                    "sources": ["alice"],
                    "hours": [9],
                    "paid_until": paid_until,
                    "pro_source": "paid",
                }),
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
        for uid in ["1", "2", "3"]:
            self.assertIn("first_preview_delivered_at",
                          harness.users[uid]["setup"])
        self.assertEqual(len(harness.user_saves), 3)

        first_timestamps = {
            uid: harness.users[uid]["setup"]["first_preview_delivered_at"]
            for uid in ["1", "2", "3"]
        }
        harness.events.clear()
        harness.run()
        self.assertEqual(len(harness.user_saves), 3)
        self.assertEqual({
            uid: harness.users[uid]["setup"]["first_preview_delivered_at"]
            for uid in ["1", "2", "3"]
        }, first_timestamps)

    def test_only_the_first_empty_digest_is_acknowledged(self):
        now = datetime.now(timezone.utc)
        harness = DigestHarness(
            users={"1": timezone_confirmed(
                {"channel": None, "sources": ["alice"], "hours": [9]})},
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
                "1": timezone_confirmed({
                    "channel": None,
                    "sources": ["alice"],
                    "hours": [9],
                    "notify_empty": True,
                }),
            },
            state={"1": {"last_digest_at": (now - timedelta(days=1)).isoformat()}},
            fetched={"alice": [tweet(now - timedelta(hours=30))]},
        )

        harness.run()

        self.assertEqual(harness.events, [
            ("text", 1, "Nothing new from your sources in the window."),
        ])

    def test_later_forced_empty_digest_stays_silent_without_preference(self):
        now = datetime.now(timezone.utc)
        harness = DigestHarness(
            users={"1": timezone_confirmed(
                {"channel": None, "sources": ["alice"], "hours": [9]})},
            state={"1": {"last_digest_at": (now - timedelta(days=1)).isoformat()}},
            fetched={"alice": [tweet(now - timedelta(hours=30))]},
        )

        harness.run(force_user="1")

        self.assertEqual(harness.events, [])

    def test_preview_failure_is_not_reported_as_an_empty_digest(self):
        now = datetime.now(timezone.utc)
        harness = DigestHarness(
            users={"1": timezone_confirmed(
                {"channel": None, "sources": ["alice"], "hours": [9]})},
            state={},
            fetched={"alice": [tweet(now - timedelta(hours=1))]},
            preview_error=True,
        )

        harness.run()

        self.assertEqual(harness.events, [])
        self.assertEqual(harness.user_saves, [])

    def test_send_text_uses_html_for_briefing_identity(self):
        with patch.object(tg, "call") as call:
            tg.send_text(1, "⭐ <b>XGist Pro</b>")
        call.assert_called_once_with(
            "sendMessage", chat_id=1, text="⭐ <b>XGist Pro</b>",
            parse_mode="HTML")

    def test_account_attention_offers_both_recovery_actions(self):
        with patch.object(tg, "call") as call:
            tg.send_account_attention(1, "naval")
        params = call.call_args.kwargs
        keyboard = json.loads(params["reply_markup"])["inline_keyboard"][0]
        self.assertEqual([button["text"] for button in keyboard],
                         ["Replace account", "Keep trying"])
        self.assertEqual([button["callback_data"] for button in keyboard],
                         ["account:replace:naval", "account:keep:naval"])

    def test_timezone_confirmation_is_required_for_digest_eligibility(self):
        now = datetime.now(timezone.utc)
        harness = DigestHarness(
            users={"1": {
                "channel": None, "sources": ["alice"], "hours": [9],
                "timezone": "Europe/Kyiv",
            }},
            state={},
            fetched={"alice": [tweet(now - timedelta(hours=1))]},
        )

        harness.run()

        self.assertEqual(harness.events, [])
        self.assertEqual(harness.state, {})

    def test_digest_time_confirmation_is_required_for_digest_eligibility(self):
        now = datetime.now(timezone.utc)
        harness = DigestHarness(
            users={"1": {
                "channel": None, "sources": ["alice"], "hours": [9],
                "timezone": "Europe/Kyiv",
                "setup": {
                    "timezone_confirmed_at": "2026-01-01T00:00:00+00:00",
                },
            }},
            state={},
            fetched={"alice": [tweet(now - timedelta(hours=1))]},
        )

        harness.run()

        self.assertEqual(harness.events, [])
        self.assertEqual(harness.state, {})


if __name__ == "__main__":
    unittest.main()
