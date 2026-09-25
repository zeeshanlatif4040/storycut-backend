"""Real video export via FFmpeg.

Builds a filter_complex from the timeline JSON:
- trims/scales/crops each main-track clip (cover-fit, smart reframe offsets)
- hard cuts via concat, cross-dissolves via xfade, fades via fade filters
- images become Ken Burns zoompan segments
- text overlays via drawtext with fade/slide/pop expressions
- subtitles via generated ASS file
- voice-over + music with sidechain ducking (fallback: plain mix)

Jobs run in a background thread with -progress parsing.
"""
from __future__ import annotations
import os
import re
import json
import time
import uuid
import shutil
import threading
import subprocess
from . import store

EXPORT_DIR = store.DIRS["exports"]
JOBS: dict[str, dict] = {}
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

OUTPUTS = {
    "16:9": {"720p": (1280, 720), "1080p": (1920, 1080),
             "1440p": (2560, 1440), "4K": (3840, 2160)},
    "9:16": {"720p": (720, 1280), "1080p": (1080, 1920),
             "1440p": (1440, 2560), "4K": (2160, 3840)},
    "1:1": {"720p": (720, 720), "1080p": (1080, 1080),
            "1440p": (1440, 1440), "4K": (2160, 2160)},
}


def _have_encoder(name: str) -> bool:
    try:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                             capture_output=True, text=True, timeout=30).stdout
        return name in out
    except Exception:
        return False


def _resolve_upload(p: str | None) -> str | None:
    """Client sends an upload file name; resolve it inside the uploads dir."""
    if not p:
        return None
    if os.path.isabs(p) and os.path.exists(p):
        return p
    try:
        cand = store.safe_join(store.DIRS["uploads"], os.path.basename(p))
    except ValueError:
        return None
    return cand if os.path.exists(cand) else None


def _video_encoder() -> tuple[str, list[str]]:
    for enc, extra in (("h264_nvenc", ["-preset", "p4"]),
                       ("h264_qsv", ["-preset", "veryfast"]),
                       ("libx264", ["-preset", "veryfast"])):
        if _have_encoder(enc) and _encoder_usable(enc):
            return enc, extra
    return "mpeg4", []


_encoder_cache: dict[str, bool] = {}


def _encoder_usable(enc: str) -> bool:
    """Actually try a 3-frame encode; listing an encoder ≠ having the hardware."""
    if enc in _encoder_cache:
        return _encoder_cache[enc]
    try:
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", "testsrc=duration=0.2:size=320x240:rate=10",
             "-frames:v", "3", "-c:v", enc, "-f", "null", "-"],
            capture_output=True, timeout=60)
        ok = r.returncode == 0
    except Exception:
        ok = False
    _encoder_cache[enc] = ok
    return ok


def _esc_drawtext(s: str) -> str:
    return (s.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
             .replace("\n", " ").replace("%", "\\%"))


def _ass_escape(s: str) -> str:
    return s.replace("\n", "\\N")


def build_ass(sub_cues: list[dict], path: str, style: dict, W: int, H: int):
    fontsize = int(style.get("size", 44) * (W / 1280))
    color = style.get("color", "#FFFFFF")
    def ass_col(hexcol):
        hexcol = hexcol.lstrip("#")
        if len(hexcol) == 6:
            r, g, b = hexcol[0:2], hexcol[2:4], hexcol[4:6]
            return f"&H00{b}{g}{r}"
        return "&H00FFFFFF"
    pos = style.get("position", "bottom")
    align = {"bottom": 2, "top": 8, "middle": 5}.get(pos, 2)
    header = ("[Script Info]\nScriptType: v4.00+\nPlayResX: %d\nPlayResY: %d\n"
              "[V4+ Styles]\n"
              "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour,"
              " OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut,"
              " ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow,"
              " Alignment, MarginL, MarginR, MarginV, Encoding\n"
              "Style: Sub,DejaVu Sans,%d,%s,&H000019FF,&H00000000,&H80000000,"
              "%d,0,0,0,100,100,0,0,1,%d,1,%d,40,40,%d,1\n"
              "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL,"
              " MarginR, MarginV, Effect, Text\n" % (
                  W, H, fontsize, ass_col(color),
                  -1 if style.get("weight") == "bold" else 0,
                  int(style.get("outline", 2)),
                  align, int(H * 0.06)))
    def ts(t):
        h = int(t // 3600); m = int((t % 3600) // 60); s = t % 60
        return f"{h}:{m:02d}:{s:05.2f}"
    lines = [header]
    for c in sub_cues:
        bg = ""
        if style.get("background"):
            bg = "{\\bord0\\shad0}"  # simple; box bg approximated via BorderStyle 3
        lines.append(
            f"Dialogue: 0,{ts(c['start'])},{ts(c['end'])},Sub,,0,0,0,,{bg}{_ass_escape(c['text'])}")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff"}

# Transitions are strictly opt-in, short and subtle: no dissolve may exceed
# this, in either the preview or the export.
MAX_TRANSITION = 0.5


def _tl_dur(clip: dict) -> float:
    return float(clip.get("end", 0)) - float(clip.get("start", 0))


def _transition_layout(clips: list[dict], disabled: bool = False) -> list[float]:
    """Effective dissolve duration per clip (index 0 is always 0.0).

    This is the single source of truth for transition timing; the frontend
    preview implements the identical rule so both agree exactly:
      td = min(requested, 0.5, output_dur_so_far / 2, clip_dur / 2)
    Cuts, non-dissolve types, tiny durations (<=0.05s) and the global
    transitionsDisabled flag all yield 0.0 (hard cut, no timeline shortening).
    """
    tds = [0.0]
    if not clips:
        return tds
    acc_dur = _tl_dur(clips[0])
    for i in range(1, len(clips)):
        dur = _tl_dur(clips[i])
        tr = (clips[i].get("transitionIn") or {})
        td = 0.0
        if not disabled and tr.get("type") == "dissolve":
            td = min(float(tr.get("duration") or 0.5), MAX_TRANSITION,
                     acc_dur / 2, dur / 2)
            if td <= 0.05:
                td = 0.0
        tds.append(td)
        acc_dur = acc_dur + dur - td
    return tds


def expected_output_duration(clips: list[dict], disabled: bool = False) -> float:
    """What the export timeline will actually last (xfade shortens by td)."""
    tds = _transition_layout(clips, disabled)
    return sum(_tl_dur(c) for c in clips) - sum(tds)


def _clip_is_still_image(clip: dict) -> bool:
    """True for still images regardless of source (user_image, broll image...).

    Previously only 'user_image' got the Ken Burns loop path, so b-roll
    images were trimmed as single-frame video -> 1-frame exports.
    """
    mt = str(clip.get("mediaType") or clip.get("kind") or "").lower()
    if mt == "image":
        return True
    for key in ("localPath", "assetId", "name"):
        v = clip.get(key)
        if v and os.path.splitext(str(v))[1].lower() in _IMAGE_EXTS:
            return True
    return False


def _clip_filter(clip: dict, W: int, H: int, fps: int, idx: int) -> tuple[str, str]:
    """Return (filter_chain_for_input, label). Input index idx -> [cv{idx}]."""
    src_start = float(clip.get("srcStart", 0) or 0)
    dur = max(0.1, float(clip.get("end", 1)) - float(clip.get("start", 0)))
    speed = float(clip.get("speed", 1) or 1)
    st = clip.get("sourceType", "")
    label = f"cv{idx}"
    f = f"[{idx}:v]"
    if st == "user_image" or _clip_is_still_image(clip):
        f += f"loop=loop=-1:size=1,"
        # Ken Burns: slow zoom
        f += (f"scale=8000:-1,zoompan=z='min(zoom+0.0008,1.25)':d={int(dur*fps)}:"
              f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={W}x{H}:fps={fps},")
    else:
        if src_start > 0:
            f += f"trim=start={src_start}:duration={dur/speed if speed else dur},"
        else:
            f += f"trim=duration={dur/speed if speed else dur},"
        f += "setpts=PTS-STARTPTS,"
        if speed and abs(speed - 1.0) > 0.01:
            f += f"setpts={1.0/speed}*PTS,"
    # cover-fit scale + crop with reframe focal point
    fx = float((clip.get("transform") or {}).get("focalX", 0.5))
    fy = float((clip.get("transform") or {}).get("focalY", 0.5))
    f += (f"scale={W}:{H}:force_original_aspect_ratio=increase,"
          f"crop={W}:{H}:x='(in_w-{W})*{fx}':y='(in_h-{H})*{fy}',")
    f += f"fps={fps},format=yuv420p,"
    # color filters
    flt = clip.get("filter") or {}
    if flt.get("grayscale"):
        f += "hue=s=0,"
    if flt.get("sepia"):
        f += "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131,"
    eq = []
    if flt.get("brightness") not in (None, 0):
        eq.append(f"brightness={float(flt['brightness']):.2f}")
    if flt.get("contrast") not in (None, 1):
        eq.append(f"contrast={float(flt['contrast']):.2f}")
    if flt.get("saturation") not in (None, 1):
        eq.append(f"saturation={float(flt['saturation']):.2f}")
    if eq:
        f += "eq=" + ":".join(eq) + ","
    op = float(clip.get("opacity", 1) or 1)
    if op < 1:
        f += f"format=rgba,colorchannelmixer=aa={op},"
    f += f"trim=duration={dur},setpts=PTS-STARTPTS[{label}]"
    return f, label


def _drawtext_filter(ov: dict, W: int, H: int, static: bool = False) -> str:
    """drawtext chain for one overlay.

    static=True renders the final resting state with no animation (global
    "Disable all text animations"): full opacity, no slide-in offset, no
    pop scaling, and stat counters show their settled value.
    """
    raw_text = ov.get("text", "")
    t1, t2 = float(ov.get("start", 0)), float(ov.get("end", 1))
    style = ov.get("style", "fade")
    size = int(ov.get("size", 64) * (W / 1280))
    color = ov.get("color", "#FFFFFF")
    font = FONT if os.path.exists(FONT) else None
    # animated counter for numeric stats: counts 1 -> target over the hold
    tval = _esc_drawtext(raw_text)
    m = re.fullmatch(r"\s*([\d,]+(?:\.\d+)?)\s*", raw_text) if ov.get("kind") == "stat" else None
    if m:
        try:
            target = float(m.group(1).replace(",", ""))
        except ValueError:
            target = 0
        if target > 1:
            if static:
                # settled value, formatted exactly like the preview's final frame
                done = f"{int(round(target)):,}" if target.is_integer() else f"{target:.1f}"
                tval = _esc_drawtext(raw_text.replace(m.group(1), done, 1))
            else:
                c_dur = max(0.6, (t2 - t1) - 0.5)
                fmt = "d" if target.is_integer() else ".1f"
                expr = (f"if(lt(t-{t1:.3f},{c_dur:.3f}),"
                        f"1+{target - 1:g}*(t-{t1:.3f})/{c_dur:.3f},{target:g})")
                tval = "%{eif\\:" + expr + "\\:" + fmt + "}"
    base = f"drawtext={('fontfile=' + font + ':') if font else ''}text='{tval}'"
    base += f":fontsize={size}:fontcolor={color}"
    base += ":borderw=2:bordercolor=black@0.8"
    x_expr, y_expr = "(w-text_w)/2", "h*0.78"
    if style == "lower-third":
        x_expr, y_expr = "60", "h*0.72"
    elif style == "stat-pop":
        x_expr, y_expr = "(w-text_w)/2", "(h-text_h)/2"
    if static:
        base += f":x='{x_expr}':y='{y_expr}':alpha='1'"
    else:
        fade = 0.4
        a_in = f"if(lt(t,{t1}),0,if(lt(t,{t1}+{fade}),(t-{t1})/{fade},1))"
        a_out = f"if(gt(t,{t2}),0,if(gt(t,{t2}-{fade}),({t2}-t)/{fade},1))"
        a_expr = f"({a_in})*({a_out})"
        if style == "slide":
            y_expr = f"(h*0.78)+80*(1-({a_in}))"
        if style == "stat-pop":
            base = base.replace(f":fontsize={size}",
                                f":fontsize='({size})*(0.6+0.4*({a_in}))'")
        base += f":x='{x_expr}':y='{y_expr}':alpha='{a_expr}'"
    base += f":enable='between(t,{t1},{t2})'"
    return base


def render_job(job_id: str, timeline: dict, settings: dict):
    job = JOBS[job_id]
    try:
        _run(job_id, timeline, settings)
    except Exception as e:  # noqa: BLE001
        job["status"] = "failed"
        job["error"] = str(e)[:500]
        store.log_event("export_failed", job=job_id, error=str(e)[:200])


def _run(job_id: str, timeline: dict, settings: dict):
    job = JOBS[job_id]
    fmt = settings.get("format", "16:9")
    quality = settings.get("quality", "1080p")
    fps = int(settings.get("fps", 30))
    W, H = OUTPUTS.get(fmt, OUTPUTS["16:9"]).get(quality, (1920, 1080))

    clips = [c for c in timeline.get("clips", []) if c.get("trackId") == "v_main"]
    clips.sort(key=lambda c: c.get("start", 0))
    if not clips:
        raise RuntimeError("No clips on the main track to export")

    total = max(c.get("end", 0) for c in timeline.get("clips", []))
    total = max(total, 1.0)

    inputs: list[list[str]] = []
    filters: list[str] = []
    # map clip -> input index (dedupe same file)
    file_index: dict[str, int] = {}

    def add_input(path: str) -> int:
        if path in file_index:
            return file_index[path]
        if not os.path.exists(path):
            raise RuntimeError(f"Source file missing: {os.path.basename(path)}")
        file_index[path] = len(inputs)
        inputs.append(["-i", path])
        return file_index[path]

    labels = []
    for i, clip in enumerate(clips):
        if clip.get("sourceType") == "gap":
            # render missing visuals as honest black slug (matches preview)
            dur = max(0.5, float(clip.get("end", 1)) - float(clip.get("start", 0)))
            ii = len(inputs)
            inputs.append(["-f", "lavfi", "-i",
                           f"color=c=black:s={W}x{H}:r={fps}:d={dur:.3f}"])
            filters.append(f"[{ii}:v]fps={fps},trim=duration={dur:.3f},setpts=PTS-STARTPTS,"
                           f"format=yuv420p[cv{i}]")
            labels.append((f"cv{i}", clip))
            continue
        p = _resolve_upload(clip.get("localPath") or clip.get("assetId") or clip.get("name"))
        if not p:
            raise RuntimeError(
                f"Clip {clip.get('clipId')} source not downloaded yet — "
                "replace it or wait for its B-roll download to finish")
        ii = add_input(p)
        f, label = _clip_filter(clip, W, H, fps, ii)
        filters.append(f)
        labels.append((label, clip))

    # chain: concat / xfade (normalize timebases first — xfade requires identical tb)
    # Timing comes from _transition_layout so preview and export agree exactly.
    tds = _transition_layout(clips, disabled=bool(timeline.get("transitionsDisabled")))
    acc = labels[0][0]
    acc_dur = _tl_dur(clips[0])
    for i in range(1, len(labels)):
        lab, clip = labels[i]
        dur = _tl_dur(clip)
        td = tds[i]
        aN, bN, nxt = f"an{i}", f"bn{i}", f"acc{i}"
        # xfade/concat need identical CFR + pix fmt + timebase on both inputs.
        # Re-assert fps/format here: upstream chains (image loop/zoompan,
        # lavfi slugs, odd source files) can otherwise hand xfade a 1/0 or
        # VFR stream, which fails filter config with "must be constant
        # frame rate". fps/format are idempotent, so double-apply is safe.
        filters.append(f"[{acc}]settb=AVTB[{aN}];[{lab}]settb=AVTB[{bN}]")
        if td > 0:
            filters.append(
                f"[{aN}][{bN}]xfade=transition=fade:duration={td:.3f}:"
                f"offset={acc_dur - td:.3f}[{nxt}]")
            acc_dur = acc_dur + dur - td
        else:
            filters.append(f"[{aN}][{bN}]concat=n=2:v=1:a=0[{nxt}]")
            acc_dur = acc_dur + dur
        acc = nxt
    # global fade in/out
    filters.append(f"[{acc}]fade=t=in:st=0:d=0.5,fade=t=out:st={max(0.5, acc_dur-0.8):.3f}:d=0.8[{acc}f]")
    acc = acc + "f"

    # text overlays
    static_text = bool(timeline.get("textAnimationsDisabled"))
    for ov in timeline.get("overlays", []):
        if ov.get("trackId", "gfx") != "gfx":
            continue
        nxt = acc + "t"
        filters.append(f"[{acc}]{_drawtext_filter(ov, W, H, static=static_text)}[{nxt}]")
        acc = nxt

    # subtitles
    ass_path = os.path.join(EXPORT_DIR, f"{job_id}.ass")
    sub_cues = timeline.get("subtitles", [])
    sub_style = timeline.get("subtitleStyle", {})
    if sub_cues and timeline.get("subtitlesEnabled", True):
        build_ass(sub_cues, ass_path, sub_style, W, H)
        nxt = acc + "s"
        esc = ass_path.replace(":", "\\:").replace("'", "\\'")
        filters.append(f"[{acc}]subtitles='{esc}':fontsdir='/usr/share/fonts'[{nxt}]")
        acc = nxt

    filter_complex = ";\n".join(filters)

    # audio
    audio_inputs: list[str] = []
    voice = _resolve_upload(timeline.get("voicePath"))
    music = _resolve_upload(timeline.get("musicPath"))
    if voice:
        audio_inputs.append(voice)
    if music and timeline.get("musicEnabled"):
        audio_inputs.append(music)

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1"]
    for args in inputs:
        cmd += args
    a_off = len(inputs)
    for p in audio_inputs:
        cmd += ["-i", p]
    cmd += ["-filter_complex", filter_complex, "-map", f"[{acc}]"]

    if len(audio_inputs) == 2:
        v_idx, m_idx = a_off, a_off + 1
        duck = float(timeline.get("ducking", 0.35) or 0)
        if duck > 0:
            cmd += ["-filter_complex",
                    f"[{m_idx}:a]volume={1.0-duck:.2f}[mduck];"
                    f"[{m_idx}:a][{v_idx}:a]sidechaincompress=threshold=0.03:ratio=6:"
                    f"attack=25:release=450[mcomp];"
                    f"[mcomp][{v_idx}:a]amix=inputs=2:duration=first:dropout_transition=0[aout]",
                    ]
            # NOTE: two -filter_complex flags: merge manually below
        cmd = _merge_filter_complex(cmd, filter_complex, v_idx, m_idx, duck)
    elif len(audio_inputs) == 1:
        v_idx = a_off
        cmd += ["-map", f"{v_idx}:a", "-shortest"]
    else:
        cmd += ["-an"]

    enc, extra = _video_encoder()
    cmd += ["-c:v", enc] + extra + ["-pix_fmt", "yuv420p", "-r", str(fps),
            "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"]
    out_path = os.path.join(EXPORT_DIR, f"{job_id}.mp4")
    cmd += [out_path]
    job["output"] = out_path

    store.log_event("export_started", job=job_id, w=W, h=H, fps=fps, enc=enc,
                    clips=len(clips))
    t0 = time.time()
    dbg_path = os.path.join(EXPORT_DIR, job_id + "_debug.log")
    dbg_f = open(dbg_path, "w")
    dbg_f.write("CMD:\n" + " ".join(cmd) + "\n\nFILTER:\n" +
                (filter_complex or "") + "\n\nSTDERR:\n")
    dbg_f.flush()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=dbg_f,
                            text=True, bufsize=1)
    job["proc"] = proc
    out_time = 0.0
    for line in proc.stdout or []:
        m = re.match(r"out_time_ms=(\d+)", line.strip())
        if m:
            out_time = int(m.group(1)) / 1_000_000
            job["progress"] = min(0.99, out_time / max(1.0, total))
    rc = proc.wait()
    dbg_f.close()
    job["elapsed"] = round(time.time() - t0, 1)
    if rc != 0:
        try:
            with open(dbg_path) as f:
                full_err = f.read()
        except Exception:
            full_err = ""
        raise RuntimeError(f"ffmpeg failed (rc={rc}): {full_err[-800:]}")
    if not os.path.exists(out_path):
        raise RuntimeError("ffmpeg finished but no output file was created")
    job["status"] = "done"
    job["progress"] = 1.0
    job["size"] = os.path.getsize(out_path)
    store.log_event("export_done", job=job_id, elapsed=job["elapsed"],
                    size=job["size"])


def _merge_filter_complex(cmd, video_fc, v_idx, m_idx, duck):
    """Rebuild cmd replacing the duplicated -filter_complex with one combined."""
    # find and remove the last two -filter_complex occurrences, rebuild properly
    args = []
    i = 0
    fcs = []
    while i < len(cmd):
        if cmd[i] == "-filter_complex":
            fcs.append(cmd[i + 1])
            i += 2
        else:
            args.append(cmd[i])
            i += 1
    video_fc = fcs[0]
    if duck > 0 and len(fcs) > 1:
        audio_fc = (f"[{m_idx}:a]volume={1.0-duck:.2f},"
                    f"sidechaincompress=threshold=0.03:ratio=6:attack=25:release=450[mcomp];"
                    f"[mcomp][{v_idx}:a]amix=inputs=2:duration=first:dropout_transition=0[aout]")
        combined = video_fc + ";\n" + audio_fc
        # re-insert before -map
        out = []
        inserted = False
        for a in args:
            if a == "-map" and not inserted:
                out += ["-filter_complex", combined]
                inserted = True
            out.append(a)
        out += ["-map", "[aout]", "-shortest"]
        return out
    # no ducking: plain mix
    combined = video_fc + ";\n" + (
        f"[{v_idx}:a][{m_idx}:a]amix=inputs=2:duration=first:dropout_transition=0[aout]")
    out = []
    inserted = False
    for a in args:
        if a == "-map" and not inserted:
            out += ["-filter_complex", combined]
            inserted = True
        out.append(a)
    out += ["-map", "[aout]", "-shortest"]
    return out


def start_job(timeline: dict, settings: dict) -> str:
    job_id = "job_" + uuid.uuid4().hex[:12]
    JOBS[job_id] = {"id": job_id, "status": "running", "progress": 0.0,
                    "created": time.time()}
    th = threading.Thread(target=render_job, args=(job_id, timeline, settings),
                          daemon=True)
    th.start()
    return job_id
