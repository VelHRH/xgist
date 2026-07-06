"""Turn a tweet into a channel-ready caption with Claude."""

import logging
import os

from .config import CLAUDE_MODEL

log = logging.getLogger(__name__)


LANGUAGES = {"en": "English", "uk": "Ukrainian", "ru": "Russian"}


def make_caption(tweet: dict, user: dict) -> str:
    fallback = tweet["text"][:900].strip()
    if not tweet["text"] or not os.getenv("ANTHROPIC_API_KEY"):
        return fallback
    try:
        return _claude_caption(tweet, user)
    except Exception:
        log.exception("caption generation failed, using raw tweet text")
        return fallback


def _claude_caption(tweet: dict, user: dict) -> str:
    import anthropic

    language = LANGUAGES.get(user.get("language") or "en", "English")
    style = user.get("style") or "concise, neutral channel tone; no hashtags"
    client = anthropic.Anthropic()
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=600,
        system=(
            "You write posts for a Telegram channel based on tweets. "
            "Rewrite the tweet as a clean, self-contained channel post. "
            f"Write the post in {language}, translating if the tweet is in "
            "another language. "
            "Plain text only, under 800 characters, no preamble, no quotes "
            "around it, no links. "
            f"Style guide from the channel owner: {style}"
        ),
        messages=[{
            "role": "user",
            "content": f"Tweet by @{tweet['source']}:\n\n{tweet['text']}",
        }],
    )
    text = next(b.text for b in response.content if b.type == "text")
    return text.strip()[:900]
