"""One-off: seed Upstash Redis from the legacy repo JSON files.

Usage (from the repo root, with the legacy users.json / state.json /
feedback.json still present):

    UPSTASH_REDIS_REST_URL=https://... UPSTASH_REDIS_REST_TOKEN=... \
        python -m pipeline.migrate

Idempotent: re-running overwrites the same keys (feedback lists are
cleared first so entries aren't duplicated).
"""

import json

from .config import ROOT, UPSTASH_TOKEN, UPSTASH_URL, _redis


def _load(name: str) -> dict:
    path = ROOT / name
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def main() -> None:
    if not (UPSTASH_URL and UPSTASH_TOKEN):
        raise SystemExit("Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN first.")

    config = _load("users.json")
    state = _load("state.json").get("users", {})
    feedback = _load("feedback.json").get("users", {})

    users = config.get("users", {})
    for uid, cfg in users.items():
        _redis("SET", f"user:{uid}", json.dumps(cfg, ensure_ascii=False))
        _redis("SADD", "uids", uid)
    for uid in config.get("whitelist", []):
        _redis("SADD", "whitelist", uid)
    for uid in config.get("promo", []):
        _redis("SADD", "promo", uid)
    for uid, st in state.items():
        _redis("SET", f"state:{uid}", json.dumps(st, ensure_ascii=False))
    for uid, rows in feedback.items():
        _redis("DEL", f"feedback:{uid}")
        for row in rows:
            _redis("RPUSH", f"feedback:{uid}", json.dumps(row, ensure_ascii=False))

    print(f"migrated {len(users)} users, "
          f"{len(config.get('whitelist', []))} whitelisted, "
          f"{len(config.get('promo', []))} promo grants, "
          f"{len(state)} state entries, "
          f"{sum(len(r) for r in feedback.values())} feedback rows")


if __name__ == "__main__":
    main()
