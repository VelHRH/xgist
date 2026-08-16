import asyncio
import os

import requests

from .fetch import _get_api


def classify_error(exc: Exception) -> str:
    message = str(exc).lower()
    if any(value in message for value in ("not found", "does not exist", "suspended")):
        return "nonexistent"
    if any(value in message for value in ("protected", "private", "not authorized")):
        return "protected"
    if any(value in message for value in (
        "timeout", "timed out", "rate limit", "429", "503", "connection",
        "no active accounts", "403",
    )):
        return "transient"
    return "unreadable"


async def validate(handle: str) -> str:
    try:
        api = await _get_api()
        user = await api.user_by_login(handle)
        if user is None:
            return "nonexistent"
        if getattr(user, "protected", False):
            return "protected"
        async for _ in api.user_tweets(user.id, limit=1):
            break
        return "readable"
    except Exception as exc:
        return classify_error(exc)


def main() -> None:
    handle = os.environ["ACCOUNT_HANDLE"].strip().lower()
    chat_id = os.environ["FORCE_USER"].strip()
    worker_url = os.environ["WORKER_URL"].strip()
    webhook_secret = os.environ["WEBHOOK_SECRET"]
    outcome = asyncio.run(validate(handle))
    response = requests.post(
        worker_url,
        json={"account_validation": {
            "chat_id": chat_id, "handle": handle, "outcome": outcome,
        }},
        headers={"x-telegram-bot-api-secret-token": webhook_secret},
        timeout=30,
    )
    response.raise_for_status()


if __name__ == "__main__":
    main()
