"""Reconstruct a thread author's self-reply chain from fetched tweet dicts.

The chain assembly (`build_chain`) is a pure function over already-fetched
tweet dicts — it does no I/O and never imports twscrape — so it can be
inspected and tested without a network or account pool. The twscrape glue
that gathers the pool lives in fetch.py (`fetch_thread`).
"""

import re

# The numeric id in an x.com / twitter.com status URL, tolerating www./mobile.
# subdomains and any query/fragment suffix.
_STATUS_RE = re.compile(r"(?:twitter|x)\.com/[^/]+/status/(\d+)", re.IGNORECASE)


def parse_tweet_id(url: str) -> str | None:
    """Extract the numeric tweet id from a status URL, or None if it isn't one."""
    m = _STATUS_RE.search(url or "")
    return m.group(1) if m else None


def build_chain(pool: dict[str, dict], linked_id: str) -> list[dict]:
    """Return the thread author's self-reply chain, in thread order.

    `pool` maps tweet id → tweet dict (needs at least `id`, `author`,
    `in_reply_to` and `date`); `linked_id` is the pasted tweet. Starting from
    the linked tweet, we gather every tweet by the same author that is
    connected to it through self-reply edges (a parent it replied to, or a
    reply to it), then order by date: the author's root tweet first, then
    forward through consecutive self-replies.

    Because only same-author reply edges are traversed, a reply into another
    conversation or a quote tweet (whose parent, if any, is someone else's
    tweet) has no same-author parent, so the chain simply starts at the linked
    tweet. Other authors' tweets are never included.
    """
    author = pool[linked_id]["author"]
    same = {tid: t for tid, t in pool.items() if t["author"] == author}

    # Same-author replies indexed by the tweet they answer.
    children: dict[str, list[str]] = {}
    for tid, t in same.items():
        parent = t.get("in_reply_to")
        if parent in same:
            children.setdefault(parent, []).append(tid)

    # Flood-fill the connected component containing the linked tweet, walking
    # both up (to the parent it replied to) and down (to its self-replies).
    seen: set[str] = set()
    stack = [linked_id]
    while stack:
        tid = stack.pop()
        if tid in seen:
            continue
        seen.add(tid)
        parent = same[tid].get("in_reply_to")
        if parent in same and parent not in seen:
            stack.append(parent)
        for child in children.get(tid, []):
            if child not in seen:
                stack.append(child)

    # Tweet ids are monotonic, so they break ties when two self-replies share
    # a timestamp (X dates are second-granularity — a burst thread can collide).
    return sorted((same[tid] for tid in seen),
                  key=lambda t: (t["date"], int(t["id"])))
