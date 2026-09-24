"""User media handling: validation, probing, thumbnails, scene moments."""
from __future__ import annotations
import os
import re
import subprocess
import hashlib
import time

ALLOWED_VIDEO = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}
ALLOWED_IMAGE = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
ALLOWED_AUDIO = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".wma",
                 ".mp4", ".webm"}  # .mp4/.webm accepted as audio containers
MAX_BYTES = 800 * 1024 * 1024


def sanitize(name: str) -> str:
    name = os.path.basename(name or "file")
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name)
    return name[:120] or "file"


def kind_of(ext: str) -> str | None:
    ext = ext.lower()
    if ext in ALLOWED_VIDEO:
        return "video"
    if ext in ALLOWED_IMAGE:
        return "image"
    if ext in ALLOWED_AUDIO:
        return "audio"
    return None


def probe(path: str) -> dict:
    """ffprobe stream info; works for video, image and audio."""
    cmd = ["ffprobe", "-v", "error", "-show_entries",
           "stream=width,height,duration,codec_name,avg_frame_rate,nb_frames:"
           "format=duration,size",
           "-of", "json", path]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        data = __import__("json").loads(out.stdout or "{}")
    except Exception:
        data = {}
    streams = data.get("streams", [])
    v = next((s for s in streams if s.get("width")), None)
    info = {"width": 0, "height": 0, "duration": 0.0, "fps": 0.0}
    if v:
        info["width"] = int(v.get("width") or 0)
        info["height"] = int(v.get("height") or 0)
        afr = v.get("avg_frame_rate") or "0/1"
        try:
            n, d = afr.split("/")
            info["fps"] = float(n) / float(d) if float(d) else 0.0
        except (ValueError, ZeroDivisionError):
            info["fps"] = 0.0
    dur = None
    if v and v.get("duration"):
        dur = v.get("duration")
    if not dur:
        dur = (data.get("format") or {}).get("duration")
    try:
        info["duration"] = float(dur or 0)
    except (ValueError, TypeError):
        info["duration"] = 0.0
    return info


def make_thumbnail(src: str, dst: str, at: float | None = None,
                   width: int = 320) -> bool:
    ss = ["-ss", str(at if at is not None else 1.0)]
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"] + ss + [
        "-i", src, "-vframes", "1",
        "-vf", f"scale={width}:-1", dst]
    try:
        subprocess.run(cmd, timeout=60, check=True)
        return os.path.exists(dst)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


def scene_moments(path: str, threshold: float = 0.35, limit: int = 40) -> list[float]:
    """Timestamps of detected scene changes (best-moment candidates)."""
    cmd = ["ffmpeg", "-hide_banner", "-i", path, "-vf",
           f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return []
    times = [float(m.group(1)) for m in
             re.finditer(r"pts_time:([\d.]+)", proc.stderr or "")]
    # de-dupe near-duplicates, cap
    out: list[float] = []
    for t in times:
        if not out or t - out[-1] > 0.5:
            out.append(round(t, 2))
        if len(out) >= limit:
            break
    return out


def audio_peaks(path: str, buckets: int = 400) -> list[float]:
    """Waveform peaks via ffmpeg astats-free approach: volumedetect per chunk is
    slow; instead decode to mono 8kHz s16 and compute max-abs per bucket in Python."""
    import array
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
           "-ac", "1", "-ar", "8000", "-f", "s16le", "-"]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=300)
    except subprocess.TimeoutExpired:
        return []
    raw = proc.stdout
    if not raw:
        return []
    samples = array.array("h", raw)
    n = len(samples)
    if n == 0:
        return []
    per = max(1, n // buckets)
    peaks = []
    for i in range(0, n, per):
        chunk = samples[i:i + per]
        peak = max((abs(s) for s in chunk), default=0) / 32768.0
        peaks.append(round(min(1.0, peak), 3))
        if len(peaks) >= buckets:
            break
    return peaks


def file_hash(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def validate_audio(path: str) -> tuple[bool, str, dict]:
    """Verify a file is a real, decodable audio file (spec: audio validation).

    Checks the actual content, not the extension:
    1. ffprobe finds an audio stream
    2. duration is detectable and > 0
    3. ffmpeg can actually decode the codec (2s decode probe)
    Returns (ok, error_message, audio_meta).
    """
    import json as _json
    cmd = ["ffprobe", "-v", "error", "-show_entries",
           "stream=codec_type,codec_name,sample_rate,channels",
           "-of", "json", path]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        data = _json.loads(out.stdout or "{}")
    except Exception:
        data = {}
    streams = data.get("streams", []) or []
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    if not audio:
        return (False,
                "no audio stream found in the file — it is not a valid audio file",
                {})
    info = probe(path)
    if info["duration"] <= 0:
        return (False,
                "audio duration could not be detected — the file may be corrupted",
                {})
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-t", "2",
           "-i", path, "-f", "null", "-"]
    try:
        subprocess.run(cmd, capture_output=True, timeout=90, check=True)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return (False,
                "the audio codec could not be decoded — convert to MP3 or WAV and retry",
                {})
    a = audio[0]
    return (True, "", {"codec": a.get("codec_name", ""),
                       "sample_rate": str(a.get("sample_rate", "")),
                       "channels": a.get("channels", "")})
