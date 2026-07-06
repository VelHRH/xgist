"""Turn a tweet into a channel-ready caption with Claude."""

import logging
import os

from .config import CLAUDE_MODEL

log = logging.getLogger(__name__)


def tweet_url(tweet: dict) -> str:
    return f"https://x.com/{tweet['source']}/status/{tweet['id']}"


def make_caption(tweet: dict, user: dict) -> str:
    link = tweet_url(tweet)
    fallback = (tweet["text"][:900] + "\n\n" + link).strip()
    if not tweet["text"] or not os.getenv("ANTHROPIC_API_KEY"):
        return fallback
    try:
        return _claude_caption(tweet, user) + "\n\n" + link
    except Exception:
        log.exception("caption generation failed, using raw tweet text")
        return fallback


def _claude_caption(tweet: dict, user: dict) -> str:
    import anthropic

    style = user.get("style") or (
        "keep the original language of the tweet; concise, neutral channel tone; no hashtags"
    )
    client = anthropic.Anthropic()
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=600,
        system=(
            "You write posts for a Telegram channel based on tweets. "
            "Rewrite the tweet as a clean, self-contained channel post. "
            "Plain text only, under 800 characters, no preamble, no quotes around it, "
            "do not include any links (a source link is appended separately). "
            f"Style guide from the channel owner: {style}"
        ),
        messages=[{
            "role": "user",
            "content": f"Tweet by @{tweet['source']}:\n\n{tweet['text']}",
        }],
    )
    text = next(b.text for b in response.content if b.type == "text")
    return text.strip()[:900]
