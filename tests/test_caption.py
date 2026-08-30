import unittest
from unittest.mock import patch

from pipeline import caption


class CaptionTest(unittest.TestCase):
    def test_refusal_falls_back_to_fetched_tweet(self):
        tweet = {
            "source": "openai",
            "text": "We're ending our partnership with Cursor following its acquisition by SpaceX.",
        }
        refusal = (
            "This looks like fabricated/fictional content. As of my knowledge cutoff, "
            "I’m not able to rewrite this tweet because it could be misleading to your audience."
        )

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test"}), \
                patch.object(caption, "_claude_caption", return_value=refusal):
            result = caption.make_caption(tweet, {})

        self.assertEqual(result, tweet["text"])

    def test_valid_rewrite_is_used(self):
        tweet = {
            "source": "openai",
            "text": "We're ending our partnership with Cursor following its acquisition by SpaceX.",
        }

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test"}), \
                patch.object(caption, "_claude_caption", return_value="OpenAI is ending its Cursor partnership."):
            result = caption.make_caption(tweet, {})

        self.assertEqual(result, "OpenAI is ending its Cursor partnership.")


if __name__ == "__main__":
    unittest.main()
