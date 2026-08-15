import unittest
from datetime import datetime, timedelta, timezone

from pipeline.plans import apply_plan, resolve_plan


class PlanTest(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 8, 16, tzinfo=timezone.utc)
        self.future = (self.now + timedelta(days=10)).isoformat()

    def test_free_plan(self):
        plan = resolve_plan("1", {}, [], [], "99", self.now)
        self.assertEqual(plan["tier"], "free")
        self.assertEqual(plan["source"], "free")
        self.assertEqual(plan["limits"]["sources"], 5)
        self.assertEqual(plan["limits"]["hours"], 1)
        self.assertEqual(plan["limits"]["thread_posts"], 1)
        self.assertEqual(plan["usage"], {"sources": 0, "hours": 0})

    def test_paid_plan(self):
        cfg = {"paid_until": self.future, "pro_source": "paid"}
        plan = resolve_plan("1", cfg, [], ["1"], "99", self.now)
        self.assertEqual(plan["tier"], "pro")
        self.assertEqual(plan["source"], "paid")
        self.assertEqual(plan["limits"]["sources"], 25)
        self.assertEqual(plan["limits"]["hours"], 6)
        self.assertEqual(plan["limits"]["thread_posts"], 5)

    def test_legacy_trial_plan(self):
        plan = resolve_plan(
            "1", {"paid_until": self.future}, [], ["1"], "99", self.now)
        self.assertEqual(plan["source"], "trial")
        self.assertEqual(plan["expires_at"], self.future)

    def test_courtesy_plan(self):
        plan = resolve_plan("1", {}, ["1"], [], "99", self.now)
        self.assertEqual(plan["source"], "courtesy")
        self.assertIsNone(plan["expires_at"])

    def test_administrator_plan(self):
        plan = resolve_plan("99", {}, [], [], "99", self.now)
        self.assertEqual(plan["source"], "administrator")
        self.assertEqual(plan["tier"], "pro")

    def test_expired_access_is_free(self):
        cfg = {"paid_until": self.now.isoformat(), "pro_source": "paid"}
        plan = resolve_plan("1", cfg, [], ["1"], "99", self.now)
        self.assertEqual(plan["source"], "free")

        cfg["paid_until"] = (self.now + timedelta(microseconds=1)).isoformat()
        plan = resolve_plan("1", cfg, [], ["1"], "99", self.now)
        self.assertEqual(plan["source"], "paid")

    def test_plan_limits_are_applied_without_mutating_config(self):
        cfg = {"sources": [str(i) for i in range(8)], "hours": list(range(8))}
        free = resolve_plan("1", cfg, [], [], "99", self.now)
        applied = apply_plan(cfg, free)
        self.assertEqual(len(applied["sources"]), 5)
        self.assertEqual(len(applied["hours"]), 1)
        self.assertEqual(len(cfg["sources"]), 8)
        self.assertEqual(len(cfg["hours"]), 8)
        self.assertEqual(applied["_plan"], free)


if __name__ == "__main__":
    unittest.main()
