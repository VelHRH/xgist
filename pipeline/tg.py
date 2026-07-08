"""Minimal Telegram Bot API client for sending digest previews."""

import json

import requests

from .config import TELEGRAM_BOT_TOKEN


def call(method: str, files=None, **params):
    resp = requests.post(
        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/{method}",
        data=params,
        files=files,
        timeout=180,
    )
    payload = resp.json()
    if not payload.get("ok"):
        raise RuntimeError(f"Telegram {method} failed: {payload.get('description')}")
    return payload["result"]


def send_preview(chat_id: int, media: list[tuple[str, str]], caption: str) -> list[dict]:
    """Send the content message(s) a user will approve. Returns the Messages."""
    if not media:
        msg = call("sendMessage", chat_id=chat_id, text=caption[:4096], parse_mode="HTML")
        return [msg]

    if len(media) == 1:
        kind, path = media[0]
        method = "sendPhoto" if kind == "photo" else "sendVideo"
        with open(path, "rb") as fh:
            msg = call(method, files={kind: fh},
                       chat_id=chat_id, caption=caption[:1024], parse_mode="HTML")
        return [msg]

    handles, input_media = [], []
    try:
        for i, (kind, path) in enumerate(media):
            fh = open(path, "rb")
            handles.append(fh)
            item = {"type": kind, "media": f"attach://m{i}"}
            if i == 0:
                item["caption"] = caption[:1024]
                item["parse_mode"] = "HTML"
            input_media.append(item)
        msgs = call(
            "sendMediaGroup",
            files={f"m{i}": fh for i, fh in enumerate(handles)},
            chat_id=chat_id,
            media=json.dumps(input_media),
        )
    finally:
        for fh in handles:
            fh.close()
    return msgs


def media_refs(msgs: list[dict]) -> list[dict]:
    """Extract {id, type, file_id} per media message — lets the Worker
    re-edit the preview (e.g. toggle the spoiler blur) via editMessageMedia."""
    refs = []
    for m in msgs:
        if m.get("photo"):
            refs.append({"id": m["message_id"], "type": "photo",
                         "file_id": m["photo"][-1]["file_id"]})
        elif m.get("video"):
            refs.append({"id": m["message_id"], "type": "video",
                         "file_id": m["video"]["file_id"]})
    return refs


def send_controls(chat_id: int, content_ids: list[int], label: str) -> None:
    """Send the approve/skip buttons referencing the content message ids."""
    ids = ",".join(map(str, content_ids))
    keyboard = {"inline_keyboard": [
        [{"text": "✅ Post", "callback_data": f"p:{ids}"},
         {"text": "❌ Skip", "callback_data": f"s:{ids}"}],
        [{"text": "✏️ Edit", "callback_data": f"e:{ids}"},
         {"text": "🫥 Spoiler", "callback_data": f"sp1:{ids}"}],
    ]}
    call("sendMessage", chat_id=chat_id, text=label[:4096],
         parse_mode="HTML",
         link_preview_options=json.dumps({"is_disabled": True}),
         reply_markup=json.dumps(keyboard))


def send_text(chat_id: int, text: str) -> None:
    call("sendMessage", chat_id=chat_id, text=text[:4096])
