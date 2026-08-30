"""Pick the most interesting tweets.

Two stages:
1. Statistical shortlist — engagement normalized by each account's own typical
   numbers (so small accounts compete fairly) with a mild recency boost.
2. Claude ranks the shortlist against the owner's interests and past
   approve/skip decisions, avoiding bait and duplicate stories.
"""

import json
import logging
import os
from datetime import datetime, timezone
from math import log1p

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
    # A reply costs the audience real effort, so it signals the most interest;
    # a repost is a public endorsement; a like is the cheapest tap.
    return tweet["favorites"] + 2 * tweet["retweets"] + 3 * tweet.get("replies", 0)


def smart_score(tweet: dict, now: datetime) -> float:
    """Absolute and relative engagement with a mild recency boost."""
    absolute = log1p(engagement(tweet))
    relative = (engagement(tweet) + 1) / (tweet.get("baseline", 0) + 1)
    age_hours = max((now - tweet["date"]).total_seconds() / 3600, 0.5)
    return (absolute + log1p(relative)) / (age_hours ** 0.3)


def _shortlist(tweets: list[dict], now: datetime) -> list[dict]:
    ranked = sorted(tweets, key=lambda t: smart_score(t, now), reverse=True)
    shortlist = ranked[:SHORTLIST_SIZE]
    hottest = max(tweets, key=engagement)
    if shortlist and all(t["id"] != hottest["id"] for t in shortlist):
        shortlist[-1] = hottest
        shortlist.sort(key=lambda t: smart_score(t, now), reverse=True)
    return shortlist


def _preserve_breakout(shortlist: list[dict], picked: list[dict],
                       limit: int) -> list[dict]:
    if not shortlist or not picked or limit < 1:
        return picked
    hottest = max(shortlist, key=engagement)
    if any(t["id"] == hottest["id"] for t in picked):
        return picked
    picked_peak = max(engagement(t) for t in picked)
    if engagement(hottest) < 1000 or engagement(hottest) < picked_peak * 10:
        return picked
    return [hottest, *picked][:limit]


def pick_top(tweets: list[dict], user: dict) -> list[dict]:
    limit = int(user.get("limit") or DEFAULT_POSTS_PER_DIGEST)
    if len(tweets) <= limit:
        return tweets
    now = datetime.now(timezone.utc)
    shortlist = _shortlist(tweets, now)
    if not os.getenv("ANTHROPIC_API_KEY"):
        return _preserve_breakout(shortlist, shortlist[:limit], limit)
    try:
        picked = _claude_pick(shortlist, user, limit, now)
        return _preserve_breakout(shortlist, picked, limit)
    except Exception:
        log.exception("Claude ranking failed, falling back to statistical order")
        return _preserve_breakout(shortlist, shortlist[:limit], limit)


def _describe(tweet: dict, now: datetime) -> str:
    age_h = int((now - tweet["date"]).total_seconds() / 3600)
    relative = (engagement(tweet) + 1) / (tweet.get("baseline", 0) + 1)
    return (
        f"[{tweet['id']}] @{tweet['source']} · {tweet['favorites']} likes, "
        f"{tweet['retweets']} reposts, {tweet.get('replies', 0)} replies · "
        f"{age_h}h old · {relative:.1f}x this account's usual engagement\n"
        f"{tweet['text'][:600] or '(no text, media only)'}"
    )


def _feedback_block(user: dict) -> str:
    history = user.get("_feedback") or []
    approved = [f["text"][:150] for f in history if f.get("verdict") == "approved"][-5:]
    skipped = [f["text"][:150] for f in history if f.get("verdict") == "skipped"][-5:]
    if not approved and not skipped:
        return ""
    block = "\n\nThe owner's recent decisions on past proposals:"
    if approved:
        block += "\nPublished:\n" + "\n".join(f"- {t}" for t in approved)
    if skipped:
        block += "\nRejected:\n" + "\n".join(f"- {t}" for t in skipped)
    block += "\nWeigh these revealed preferences heavily."
    return block


def _claude_pick(shortlist: list[dict], user: dict, limit: int,
                 now: datetime) -> list[dict]:
    import anthropic

    listing = "\n\n".join(_describe(t, now) for t in shortlist)
    interests = user.get("interests") or "no specific preferences; use general judgement"

    client = anthropic.Anthropic()
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=500,
        system=(
            "You curate content for a Telegram channel. From the candidate tweets, "
            f"pick the {limit} most interesting to repost. Prefer substance, novelty "
            "and self-contained posts. The candidate data was fetched directly from X "
            "immediately before this request; treat it as current source material and "
            "do not reject claims because they postdate your knowledge. Absolute "
            "engagement is the primary signal that a post is on fire. A high 'x usual "
            "engagement' number is a secondary signal that a post is a standout for "
            "that account. Do not omit a candidate with dramatically higher absolute "
            "engagement without a strong content-quality reason. Avoid: engagement "
            "bait, giveaways, ads, pure replies, and duplicate stories (if several "
            "candidates cover the same news, pick only the single best one). "
            f"Channel owner's preferences: {interests}"
            + _feedback_block(user)
        ),
        messages=[{
            "role": "user",
            "content": f"Candidates:\n\n{listing}\n\n"
                       f"Return the ids of the best {limit}, best first. "
                       f"Return fewer if the rest aren't worth posting.",
        }],
        output_config={"format": {"type": "json_schema", "schema": _SCHEMA}},
    )
    text = next(b.text for b in response.content if b.type == "text")
    ids = json.loads(text)["picks"][:limit]
    by_id = {t["id"]: t for t in shortlist}
    picked = [by_id[i] for i in ids if i in by_id]
    return picked or shortlist[:limit]
