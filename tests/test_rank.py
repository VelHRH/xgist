import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from pipeline import rank


def tweet(tweet_id, favorites, retweets=0, baseline=100, age_hours=1):
    return {
        "id": tweet_id,
        "source": "source",
        "text": f"Post {tweet_id}",
        "date": datetime.now(timezone.utc) - timedelta(hours=age_hours),
        "favorites": favorites,
        "retweets": retweets,
        "replies": 0,
        "baseline": baseline,
    }


class RankTest(unittest.TestCase):
    def test_absolute_heat_outweighs_a_modest_relative_hit(self):
        now = datetime.now(timezone.utc)
        viral = tweet("viral", 21000, baseline=50000)
        modest = tweet("modest", 434, retweets=6, baseline=100)

        self.assertGreater(rank.smart_score(viral, now),
                           rank.smart_score(modest, now))

    def test_obvious_breakout_cannot_be_dropped_by_model_ranking(self):
        viral = tweet("viral", 21000, baseline=50000)
        modest = tweet("modest", 434, retweets=6, baseline=100)
        candidates = [viral, modest] + [
            tweet(str(index), 100 + index, baseline=100)
            for index in range(11)
        ]

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test"}), \
                patch.object(rank, "_claude_pick", return_value=[modest]):
            picked = rank.pick_top(candidates, {"limit": 1})

        self.assertEqual([item["id"] for item in picked], ["viral"])


if __name__ == "__main__":
    unittest.main()
