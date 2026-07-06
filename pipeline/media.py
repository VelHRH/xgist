"""Make downloaded media Telegram-ready (bot uploads are capped at ~50 MB)."""

import logging
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)

MAX_BYTES = 48 * 1024 * 1024
PHOTO_EXT = {".jpg", ".jpeg", ".png", ".webp"}
VIDEO_EXT = {".mp4", ".mov", ".m4v"}


def prepare(paths: list[str]) -> list[tuple[str, str]]:
    """Return a list of (kind, path) pairs, kind in {'photo', 'video'}."""
    out: list[tuple[str, str]] = []
    for raw in paths[:4]:  # Telegram albums hold up to 10, but keep previews light
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
