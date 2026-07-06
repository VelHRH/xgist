"""Pick the most interesting tweets: engagement shortlist, then Claude ranking."""

import json
import logging
import os

from .config import CLAUDE_MODEL, DEFAULT_POSTS_PER_DIGEST, SHORTLIST_SIZE

log = logging.getLogger(__name__)

_SCHEMA = {
    "type": "object",
    "properties": {
        "picks": {
            "type": "array",
            "items": {"type": "string"},
        }
    },
    "required": ["picks"],
    "additionalProperties": False,
}


def engagement(tweet: dict) -> int:
    return tweet["favorites"] + 2 * tweet["retweets"]


def pick_top(tweets: list[dict], user: dict) -> list[dict]:
    limit = int(user.get("limit") or DEFAULT_POSTS_PER_DIGEST)
    if len(tweets) <= limit:
        return tweets
    shortlist = sorted(tweets, key=engagement, reverse=True)[:SHORTLIST_SIZE]
    if not os.getenv("ANTHROPIC_API_KEY"):
        return shortlist[:limit]
    try:
        return _claude_pick(shortlist, user, limit)
    except Exception:
        log.exception("Claude ranking failed, falling back to engagement order")
        return shortlist[:limit]


def _claude_pick(shortlist: list[dict], user: dict, limit: int) -> list[dict]:
    import anthropic

    listing = "\n\n".join(
        f"[{t['id']}] @{t['source']} · {t['favorites']} likes, {t['retweets']} reposts\n"
        f"{t['text'][:600] or '(no text, media only)'}"
        for t in shortlist
    )
    interests = user.get("interests") or "no specific preferences; use general judgement"

    client = anthropic.Anthropic()
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=500,
        system=(
            "You curate content for a Telegram channel. From the candidate tweets, "
            f"pick the {limit} most interesting to repost. Prefer substance, novelty "
            "and self-contained posts; avoid pure replies, ads and engagement bait. "
            f"Channel owner's preferences: {interests}"
        ),
        messages=[{
            "role": "user",
            "content": f"Candidates:\n\n{listing}\n\n"
                       f"Return the ids of the best {limit}, best first.",
        }],
        output_config={"format": {"type": "json_schema", "schema": _SCHEMA}},
    )
    text = next(b.text for b in response.content if b.type == "text")
    ids = json.loads(text)["picks"][:limit]
    by_id = {t["id"]: t for t in shortlist}
    picked = [by_id[i] for i in ids if i in by_id]
    return picked or shortlist[:limit]
