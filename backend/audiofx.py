"""Audio intelligence: real FFmpeg-based analysis and enhancement.

All measurements come from actual ffprobe/ffmpeg output parsing — nothing
is estimated from the filename or guessed.

- analyze_audio(path): duration, clipping (astats peak level), mean/RMS
  volume, silence ranges (silencedetect), loudness estimate (loudnorm
  single-pass measurement, EBU R128).
- enhance_audio(in_path, out_path, opts): light FFT denoise (afftdn),
  EBU R128 loudness normalization (loudnorm two-pass), optional dynamic
  normalization (dynaudnorm). NOTE: adynamiceq is not compiled into this
  FFmpeg build, so dynaudnorm is used for the "dynamic" option and the
  result reports exactly which filters ran.
- rhythm_hints(path): energy-onset times from decoded PCM RMS buckets.
  Honest label: energy-based rhythm hints, NOT beat tracking / BPM.
"""
from __future__ import annotations
import array
import json
import math
import os
import re
import subprocess

_FFMPEG = "ffmpeg"
_FFPROBE = "ffprobe"


def _run(cmd: list[str], timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def ffprobe_duration(path: str) -> float:
    out = _run([_FFPROBE, "-v", "error", "-show_entries",
                "format=duration", "-of",
                "default=noprint_wrappers=1:nokey=1", path])
    try:
        return float(out.stdout.strip())
    except (ValueError, AttributeError):
        return 0.0


def _astats(path: str) -> dict:
    """Parse overall Peak/RMS levels from the astats filter."""
    proc = _run([_FFMPEG, "-hide_banner", "-i", path, "-af", "astats",
                 "-f", "null", "-"])
    log = proc.stderr or ""
    # astats prints per-channel blocks then an "Overall" block; every line
    # carries a "[Parsed_astats_N @ ...]" prefix, so match keys anywhere.
    overall = {}
    in_overall = False
    for line in log.splitlines():
        if re.search(r"\bOverall\s*$", line):
            in_overall = True
            continue
        if not in_overall:
            continue
        m = re.search(r"(Peak level dB|RMS level dB|DC offset)\s*:\s*"
                      r"(-?[\d.]+|inf|-inf)", line)
        if m:
            key = m.group(1).lower().replace(" ", "_")
            try:
                overall[key] = float(m.group(2))
            except ValueError:
                pass
    # The Overall block is the last section in astats output, so parsing
    # runs to end of log.
    return overall


def _loudnorm_measure(path: str) -> dict:
    """Single-pass loudnorm with print_format=json: measurement only, no
    audio is written. Returns EBU R128 measured values.

    NOTE: in measurement mode ffmpeg prints "input_i"/"input_tp"/
    "input_lra"/"input_thresh" (not "measured_*"). We map them to the
    measured_* names the two-pass loudnorm filter expects."""
    proc = _run([_FFMPEG, "-hide_banner", "-i", path, "-af",
                 "loudnorm=print_format=json", "-f", "null", "-"])
    log = proc.stderr or ""
    m = re.search(r"\{[\s\S]*?\"input_i\"[\s\S]*?\}", log)
    if not m:
        return {}
    try:
        raw = json.loads(m.group(0))
    except ValueError:
        return {}

    def _f(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    return {
        "measured_I": _f(raw.get("input_i")),
        "measured_TP": _f(raw.get("input_tp")),
        "measured_LRA": _f(raw.get("input_lra")),
        "measured_thresh": _f(raw.get("input_thresh")),
        "target_offset": _f(raw.get("target_offset")),
    }


def _silence_ranges(path: str, noise_db: float = -32.0,
                    min_dur: float = 0.4) -> list[list[float]]:
    """Silence intervals from silencedetect (same approach as analysis.py)."""
    proc = _run([_FFMPEG, "-hide_banner", "-i", path, "-af",
                 f"silencedetect=noise={noise_db}dB:d={min_dur}",
                 "-f", "null", "-"])
    log = proc.stderr or ""
    starts = [float(m.group(1))
              for m in re.finditer(r"silence_start: ([\d.]+)", log)]
    ends = [float(m.group(1))
            for m in re.finditer(r"silence_end: ([\d.]+)", log)]
    out = []
    for i, s in enumerate(starts):
        e = ends[i] if i < len(ends) else None
        if e is not None and e > s:
            out.append([round(s, 3), round(e, 3)])
    return out


def analyze_audio(path: str) -> dict:
    """Real audio analysis. Raises FileNotFoundError for missing input."""
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    duration = ffprobe_duration(path)
    stats = _astats(path)
    loud = _loudnorm_measure(path)
    silences = _silence_ranges(path)

    peak_db = stats.get("peak_level_db")
    rms_db = stats.get("rms_level_db")
    # clipping: peak at/above ~-0.1 dBFS means samples hit full scale
    clipping = bool(peak_db is not None and peak_db >= -0.1)

    return {
        "duration": round(duration, 3),
        "peak_db": None if peak_db is None else round(peak_db, 2),
        "rms_db": None if rms_db is None else round(rms_db, 2),
        "clipping": clipping,
        "mean_volume_db": None if rms_db is None else round(rms_db, 2),
        "silence_ranges": silences,
        "silence_count": len(silences),
        "loudness": {
            "integrated_lufs": loud.get("measured_I"),
            "true_peak_dbfs": loud.get("measured_TP"),
            "lra_lu": loud.get("measured_LRA"),
            "threshold_db": loud.get("measured_thresh"),
            "target_offset_lu": loud.get("target_offset"),
        },
        "method": ("ffprobe duration + astats peak/RMS + silencedetect "
                   "silences + loudnorm EBU R128 single-pass measurement"),
    }


def enhance_audio(in_path: str, out_path: str,
                  opts: dict | None = None) -> dict:
    """Apply real enhancement filters. Returns the applied chain + measured
    values. opts: {normalize: bool, denoise: bool, dynamic: bool,
    target_lufs: float}.

    Chain order: afftdn (light denoise) -> loudnorm (EBU R128, two-pass
    using measured values) -> dynaudnorm (optional dynamic normalization).
    """
    if not os.path.exists(in_path):
        raise FileNotFoundError(in_path)
    opts = opts or {}
    do_norm = bool(opts.get("normalize", True))
    do_denoise = bool(opts.get("denoise", False))
    do_dynamic = bool(opts.get("dynamic", False))
    try:
        target_lufs = float(opts.get("target_lufs", -16.0))
    except (TypeError, ValueError):
        target_lufs = -16.0
    target_lufs = max(-30.0, min(-8.0, target_lufs))

    measured: dict = {}
    chain: list[str] = []

    if do_denoise:
        # light FFT denoise: defaults are conservative; nr=8 is mild
        chain.append("afftdn=nr=8:nf=-25")

    if do_norm:
        measured = _loudnorm_measure(in_path)
        if measured:
            chain.append(
                "loudnorm=I={t}:TP=-1.5:LRA=11"
                ":measured_I={I}:measured_TP={TP}:measured_LRA={LRA}"
                ":measured_thresh={th}:offset={off}:linear=true".format(
                    t=target_lufs,
                    I=measured.get("measured_I", target_lufs),
                    TP=measured.get("measured_TP", -1.5),
                    LRA=measured.get("measured_LRA", 11),
                    th=measured.get("measured_thresh", -34.0),
                    off=measured.get("target_offset", 0.0)))
        else:
            # fallback: single-pass normalization if measurement failed
            chain.append(f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11")

    if do_dynamic:
        # adynamiceq is not in this FFmpeg build; dynaudnorm is the
        # available dynamic-range filter. Reported honestly below.
        chain.append("dynaudnorm=f=75:g=15")

    if not chain:
        raise ValueError("no enhancement selected: enable normalize, "
                         "denoise or dynamic")

    af = ",".join(chain)
    cmd = [_FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
           "-i", in_path, "-af", af, "-c:a", "pcm_s16le", out_path]
    proc = _run(cmd, timeout=600)
    if proc.returncode != 0 or not os.path.exists(out_path):
        raise RuntimeError(f"ffmpeg enhance failed: "
                           f"{(proc.stderr or '')[:300]}")

    before = analyze_audio(in_path)
    after = analyze_audio(out_path)
    return {
        "out_path": out_path,
        "filter_chain": chain,
        "filter_graph": af,
        "target_lufs": target_lufs,
        "dynamic_filter": ("dynaudnorm (adynamiceq not available in this "
                           "FFmpeg build)" if do_dynamic else None),
        "measured_before": measured,
        "before": {"integrated_lufs": before["loudness"]["integrated_lufs"],
                   "true_peak_dbfs": before["loudness"]["true_peak_dbfs"],
                   "peak_db": before["peak_db"]},
        "after": {"integrated_lufs": after["loudness"]["integrated_lufs"],
                  "true_peak_dbfs": after["loudness"]["true_peak_dbfs"],
                  "peak_db": after["peak_db"],
                  "duration": after["duration"]},
        "method": "real ffmpeg filter chain; loudness re-measured after render",
    }


def rhythm_hints(path: str, bucket_s: float = 0.05,
                 min_gap_s: float = 0.25, limit: int = 200) -> dict:
    """Energy-onset times from decoded PCM RMS buckets.

    HONEST: this is energy-based onset detection, not beat tracking. It
    finds sudden loudness jumps (good for cut points / emphasis markers);
    it does not know tempo, BPM, or musical beats.
    """
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    duration = ffprobe_duration(path)
    cmd = [_FFMPEG, "-hide_banner", "-loglevel", "error", "-i", path,
           "-ac", "1", "-ar", "8000", "-f", "s16le", "-"]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=300)
    except subprocess.TimeoutExpired:
        return {"onsets": [], "method": "decode timed out"}
    raw = proc.stdout
    if not raw:
        return {"onsets": [], "method": "no audio decoded"}
    samples = array.array("h", raw)
    per = max(1, int(8000 * bucket_s))
    buckets = []
    for i in range(0, len(samples), per):
        chunk = samples[i:i + per]
        if not chunk:
            break
        rms = math.sqrt(sum(s * s for s in chunk) / len(chunk)) / 32768.0
        buckets.append(rms)
    if not buckets:
        return {"onsets": [], "method": "no buckets"}

    # local background = rolling mean over ~1s; onset = sharp rise above it
    win = max(3, int(1.0 / bucket_s))
    onsets = []
    last_t = -min_gap_s
    for i, e in enumerate(buckets):
        lo = max(0, i - win)
        bg = sum(buckets[lo:i]) / max(1, i - lo) if i > lo else e
        prev = buckets[i - 1] if i else 0.0
        if (e > bg * 2.2 + 0.02 and e - prev > 0.03 and e > 0.05):
            t = round(i * bucket_s, 3)
            if t - last_t >= min_gap_s:
                onsets.append({"t": t,
                               "strength": round(min(1.0, e), 3)})
                last_t = t
        if len(onsets) >= limit:
            break
    return {
        "duration": round(duration, 3),
        "onsets": onsets,
        "count": len(onsets),
        "method": ("energy-based rhythm hints from PCM RMS onsets — NOT beat "
                   "tracking; no tempo/BPM is detected"),
    }
