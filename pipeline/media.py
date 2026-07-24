"""Make downloaded media Telegram-ready (bot uploads are capped at ~50 MB)."""

import json
import logging
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)

MAX_BYTES = 48 * 1024 * 1024
PHOTO_EXT = {".jpg", ".jpeg", ".png", ".webp"}
VIDEO_EXT = {".mp4", ".mov", ".m4v"}


def prepare(paths: list[str], limit: int = 4) -> list[tuple[str, str]]:
    """Return a list of (kind, path) pairs, kind in {'photo', 'video'}.

    Digest previews stay light (limit 4); thread posts pass the album max (10).
    """
    out: list[tuple[str, str]] = []
    for raw in paths[:limit]:
        path = Path(raw)
        ext = path.suffix.lower()
        if ext in PHOTO_EXT:
            out.append(("photo", str(path)))
        elif ext in VIDEO_EXT:
            if path.stat().st_size > MAX_BYTES:
                compressed = _compress(path)
                if compressed:
                    out.append(("video", str(compressed)))
                else:
                    log.warning("skipping oversized video %s", path)
            else:
                out.append(("video", str(path)))
        else:
            log.info("skipping unsupported media %s", path)
    return out


def video_meta(path: str) -> dict:
    """Probe width/height/duration — without them Telegram clients (mobile
    especially) guess the aspect ratio and render the video stretched."""
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height:format=duration",
        "-of", "json", str(path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=60)
        info = json.loads(proc.stdout or b"{}")
        stream = (info.get("streams") or [{}])[0]
        meta = {}
        if stream.get("width") and stream.get("height"):
            meta["width"] = stream["width"]
            meta["height"] = stream["height"]
        duration = (info.get("format") or {}).get("duration")
        if duration:
            meta["duration"] = int(float(duration))
        return meta
    except (subprocess.TimeoutExpired, FileNotFoundError, ValueError) as exc:
        log.warning("ffprobe failed for %s: %s", path, exc)
        return {}


def _compress(path: Path) -> Path | None:
    out = path.with_name(path.stem + "_tg.mp4")
    cmd = [
        "ffmpeg", "-y", "-i", str(path),
        "-vf", "scale='min(1280,iw)':-2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(out),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=900)
        if proc.returncode == 0 and out.exists() and out.stat().st_size <= MAX_BYTES:
            return out
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        log.error("ffmpeg failed for %s: %s", path, exc)
    return None
