"""Turn a tweet into a channel-ready caption with Claude."""

import logging
import os
import re

from .config import CLAUDE_MODEL

log = logging.getLogger(__name__)

# Matches «...» or "..." or "..." with at least 15 chars inside.
# Guillemets dominate RU/UK text; curly/straight double quotes cover EN.
_QUOTE_RE = re.compile(r'[«“"](.{15,}?)[»”"]', re.DOTALL)


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def format_caption(text: str) -> str:
    """Wrap quoted passages in <blockquote> tags and split into paragraphs.

    Returns HTML-escaped text safe for Telegram's parse_mode=HTML.
    """
    parts: list[str] = []
    last_end = 0
    for m in _QUOTE_RE.finditer(text):
        before = text[last_end:m.start()].rstrip(":— \n")
        if before.strip():
            parts.append(_escape(before.strip()))
        parts.append(f"<blockquote>{_escape(m.group(1).strip())}</blockquote>")
        last_end = m.end()
    after = text[last_end:].lstrip(".,!? \n").strip()
    if after:
        parts.append(_escape(after))
    return "\n\n".join(p for p in parts if p)


LANGUAGES = {"en": "English", "uk": "Ukrainian", "ru": "Russian"}


def make_caption(tweet: dict, user: dict) -> str:
    fallback = tweet["text"][:900].strip()
    # Don't invoke Claude if there's no meaningful text to rewrite — it would
    # hallucinate or refuse ("I can't see the image") rather than produce a post.
    if len(fallback) < 30 or not os.getenv("ANTHROPIC_API_KEY"):
        return format_caption(fallback)
    try:
        return format_caption(_claude_caption(tweet, user))
    except Exception:
        log.exception("caption generation failed, using raw tweet text")
        return format_caption(fallback)


def _claude_caption(tweet: dict, user: dict) -> str:
    import anthropic

    language = LANGUAGES.get(user.get("language") or "en", "English")
    style = user.get("style") or "concise, neutral channel tone; no hashtags"
    client = anthropic.Anthropic()
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=600,
        system=(
            "You write posts for a Telegram channel based on tweet text. "
            "Rewrite the tweet as a clean, self-contained channel post. "
            f"Write the post in {language}, translating if the tweet is in "
            "another language. "
            "Output ONLY the finished post — no preamble, no reasoning, no "
            "revision notes, no self-corrections, no meta-commentary. "
            "Under 800 characters, no hashtags, no links, no quotes around the post. "
            f"Style guide from the channel owner: {style}"
        ),
        messages=[{
            "role": "user",
            "content": f"Tweet text by @{tweet['source']}:\n\n{tweet['text']}",
        }],
    )
    text = next(b.text for b in response.content if b.type == "text")
    return text.strip()[:900]
