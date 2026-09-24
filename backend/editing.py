"""Editing controls: scene locking, source modes, creative modes, style
profiles, quality control (QC) and completion reports.

All functions here are pure logic operating on plain project dicts, plus a
small in-memory registry for per-project locks. No Flask, no I/O except
os.path.exists checks inside run_qc (real file verification).

PROJECT CONTRACT (dict shape these functions understand; every key optional):
    {
      "id": str, "format": "16:9" | "9:16",
      "duration": float,
      "segments": [ {"index": int, "start": float, "end": float,
                     "text": str, "confidence": float 0..1,
                     "origin": "user" | "broll",          # footage source
                     "media_type": "video" | "image",
                     "file": str | None,                 # resolved local path
                     "width": int, "height": int,        # asset resolution
                     "transition": str | None,
                     "alt_candidates": [ {"file": str, "width": int,
                                          "height": int}, ... ]}, ... ],
      "subtitles": [ {"start": float, "end": float, "text": str}, ... ],
      "overlays":  [ {"start": float, "end": float, "text": str,
                      "kind": "date" | "stat" | "name"}, ... ],
      "silences":  [ {"start": float, "end": float}, ... ],  # long dead air
      "transitions": [ {"at": float, "style": str}, ... ],
      "editing": { "locks": {"0": true, ...}, "source_mode": str,
                   "creative_mode": str, "profile": str }
    }
"""
from __future__ import annotations
import itertools
import math
import os

# ---------------------------------------------------------------- in-memory
# Per-project scene locks: {project_id: {scene_idx: bool}}. Survives for the
# life of the server process; the frontend also persists them inside the
# saved project dict under project["editing"]["locks"].
_LOCKS: dict[str, dict[int, bool]] = {}


def _locks_for(project_id: str) -> dict[int, bool]:
    return _LOCKS.setdefault(str(project_id), {})


def lock_scene(project_id: str, scene_idx: int, locked: bool) -> dict[int, bool]:
    """Lock/unlock a scene. Returns the full lock map for the project."""
    locks = _locks_for(project_id)
    idx = int(scene_idx)
    if locked:
        locks[idx] = True
    else:
        locks.pop(idx, None)
    return dict(locks)


def is_locked(project_id: str, scene_idx: int) -> bool:
    return bool(_locks_for(project_id).get(int(scene_idx), False))


def get_locks(project_id: str) -> dict[int, bool]:
    return dict(_locks_for(project_id))


def sync_locks_from_project(project: dict) -> dict[int, bool]:
    """Merge locks stored inside a saved project dict into the registry."""
    pid = str(project.get("id") or "default")
    locks = _locks_for(pid)
    for k, v in (project.get("editing") or {}).get("locks", {}).items():
        try:
            if v:
                locks[int(k)] = True
            else:
                locks.pop(int(k), None)
        except (TypeError, ValueError):
            continue
    return dict(locks)


# ------------------------------------------------------------ source modes
SOURCE_MODES = ["USER_ONLY", "BROLL_ONLY", "USER_FIRST",
                "BROLL_FIRST", "BALANCED", "AI_DIRECTOR"]

SOURCE_MODE_INFO = {
    "USER_ONLY":  "Use only the user's own uploaded footage.",
    "BROLL_ONLY":  "Use only stock / B-roll footage.",
    "USER_FIRST":  "Prefer user footage; fill gaps with B-roll.",
    "BROLL_FIRST": "Prefer B-roll; use user footage to fill gaps.",
    "BALANCED":   "Alternate user footage and B-roll evenly.",
    "AI_DIRECTOR": "Rank every candidate by score and pick the best mix.",
}


def _origin(item: dict) -> str:
    o = str(item.get("origin") or "").lower()
    return "user" if o == "user" else "broll"


def filter_sources(candidates: list[dict], user_media: list[dict],
                   mode: str) -> list[dict]:
    """Order footage candidates according to a source-selection mode.

    candidates: stock/B-roll items; user_media: the user's own uploads.
    Every returned item is a shallow copy tagged with "origin".
    Raises ValueError on unknown mode (never silently misbehaves).
    """
    mode = str(mode or "").upper()
    if mode not in SOURCE_MODES:
        raise ValueError(f"unknown source mode: {mode!r}")

    broll = [dict(c, origin="broll") for c in (candidates or [])]
    user = [dict(c, origin="user") for c in (user_media or [])]

    if mode == "USER_ONLY":
        return user
    if mode == "BROLL_ONLY":
        return broll
    if mode == "USER_FIRST":
        return user + broll
    if mode == "BROLL_FIRST":
        return broll + user
    if mode == "BALANCED":
        out = []
        for u, b in itertools.zip_longest(user, broll):
            if u is not None:
                out.append(u)
            if b is not None:
                out.append(b)
        return out
    # AI_DIRECTOR: merge by score (missing score -> 0.5 baseline; user
    # footage gets a small familiarity bonus so ties prefer it).
    merged = ([dict(c, _s=float(c.get("score", 0.5)) + 0.05) for c in user]
              + [dict(c, _s=float(c.get("score", 0.5))) for c in broll])
    merged.sort(key=lambda c: c["_s"], reverse=True)
    for c in merged:
        c.pop("_s", None)
    return merged


# ---------------------------------------------------------- creative modes
CREATIVE_MODES = {
    "CONSERVATIVE": {"max_candidates": 3, "transition_style": "cut",
                     "text_density": "low"},
    "BALANCED":     {"max_candidates": 5, "transition_style": "dissolve",
                     "text_density": "medium"},
    "CREATIVE":     {"max_candidates": 8, "transition_style": "mixed",
                     "text_density": "high"},
}

CREATIVE_MODE_INFO = {
    "CONSERVATIVE": "Few options per scene, hard cuts, minimal on-screen text.",
    "BALANCED": "Moderate options, smooth dissolves, standard text.",
    "CREATIVE": "Many options, varied transitions, rich on-screen text.",
}


# ------------------------------------------------------------ style profiles
# PROFILE CONTRACT — how these params are consumed by the plan builder and
# exporter (real effect, not decoration):
#   pacing_target  target seconds per scene; the plan builder groups
#                  sentences so scene duration lands near this value.
#   music_energy   0..1; maps to the bed-music ducking/selection energy
#                  used at export time (higher = louder, denser bed).
#   text_style     one of "lower-third" | "caption" | "bold-title" |
#                  "minimal" | "kinetic"; selects the drawtext preset
#                  family applied to overlays at export.
#   transition_bias one of "cut" | "dissolve" | "mixed" | "whip";
#                  default transition style stamped onto segments that do
#                  not already define one (see apply_editing_settings).
STYLE_PROFILES = {
    "DOCUMENTARY":  {"pacing_target": 6.0, "music_energy": 0.35,
                     "text_style": "lower-third", "transition_bias": "dissolve"},
    "NEWS":         {"pacing_target": 3.5, "music_energy": 0.45,
                     "text_style": "lower-third", "transition_bias": "cut"},
    "EDUCATIONAL":  {"pacing_target": 7.0, "music_energy": 0.30,
                     "text_style": "caption", "transition_bias": "dissolve"},
    "CORPORATE":    {"pacing_target": 4.5, "music_energy": 0.40,
                     "text_style": "minimal", "transition_bias": "dissolve"},
    "FACELESS":     {"pacing_target": 5.0, "music_energy": 0.55,
                     "text_style": "bold-title", "transition_bias": "mixed"},
    "STORYTELLING": {"pacing_target": 6.5, "music_energy": 0.50,
                     "text_style": "caption", "transition_bias": "dissolve"},
    "PODCAST":      {"pacing_target": 8.0, "music_energy": 0.20,
                     "text_style": "minimal", "transition_bias": "cut"},
    "SOCIAL":       {"pacing_target": 2.5, "music_energy": 0.75,
                     "text_style": "kinetic", "transition_bias": "whip"},
    "MINIMAL":      {"pacing_target": 7.5, "music_energy": 0.15,
                     "text_style": "minimal", "transition_bias": "cut"},
    "CINEMATIC":    {"pacing_target": 5.5, "music_energy": 0.60,
                     "text_style": "bold-title", "transition_bias": "dissolve"},
    "HIGH_ENERGY":  {"pacing_target": 2.0, "music_energy": 0.90,
                     "text_style": "kinetic", "transition_bias": "whip"},
}

PROFILE_INFO = {
    "DOCUMENTARY": "Slow, calm narration pacing with elegant lower-thirds.",
    "NEWS": "Fast factual cuts, tight lower-thirds.",
    "EDUCATIONAL": "Patient pacing, clear captions for learning.",
    "CORPORATE": "Clean, restrained, minimal text.",
    "FACELESS": "Punchy titles carrying the narration.",
    "STORYTELLING": "Emotional arc pacing, soft captions.",
    "PODCAST": "Long takes, almost no on-screen text.",
    "SOCIAL": "Rapid cuts, kinetic text for vertical feeds.",
    "MINIMAL": "Quiet, sparse, breathing room.",
    "CINEMATIC": "Filmic dissolves and bold titles.",
    "HIGH_ENERGY": "Maximum pace and music drive.",
}

_OVERLAY_PRIORITY = {"date": 0, "stat": 1, "name": 2}


def apply_editing_settings(project: dict, creative_mode: str = "BALANCED",
                           profile: str = "DOCUMENTARY") -> dict:
    """Apply creative mode + style profile to a project IN PLACE and return
    a summary of what changed. Real effects on the plan:

    * text_density trims on-screen overlays (low keeps at most one overlay
      per two scenes, preferring dates/stats; medium keeps one per scene;
      high keeps everything).
    * transition_bias / transition_style stamps a default transition onto
      segments that do not already define one.
    * the chosen mode/profile are recorded under project["editing"] so the
      plan builder and exporter can consume pacing_target, music_energy
      and text_style per the PROFILE CONTRACT above.
    """
    creative_mode = str(creative_mode or "BALANCED").upper()
    profile = str(profile or "DOCUMENTARY").upper()
    if creative_mode not in CREATIVE_MODES:
        raise ValueError(f"unknown creative mode: {creative_mode!r}")
    if profile not in STYLE_PROFILES:
        raise ValueError(f"unknown style profile: {profile!r}")

    cm = CREATIVE_MODES[creative_mode]
    prof = STYLE_PROFILES[profile]
    ed = project.setdefault("editing", {})
    ed["creative_mode"] = creative_mode
    ed["profile"] = profile

    changes = {"overlays_removed": 0, "transitions_stamped": 0}

    # --- text density: trim overlays honestly (no fake generation) ---
    overlays = project.get("overlays") or []
    density = cm["text_density"]
    if density in ("low", "medium") and overlays:
        n_seg = max(1, len(project.get("segments") or []))
        cap = math.ceil(n_seg / 2) if density == "low" else n_seg
        if len(overlays) > cap:
            ranked = sorted(overlays,
                            key=lambda o: _OVERLAY_PRIORITY.get(o.get("kind"), 9))
            keep_ids = {id(o) for o in ranked[:cap]}
            project["overlays"] = [o for o in overlays if id(o) in keep_ids]
            changes["overlays_removed"] = len(overlays) - len(project["overlays"])

    # --- transition default: stamp bias onto segments lacking one ---
    bias = prof["transition_bias"]
    style = cm["transition_style"] if cm["transition_style"] != "mixed" else bias
    for seg in project.get("segments") or []:
        if not seg.get("transition"):
            seg["transition"] = style
            changes["transitions_stamped"] += 1

    ed["applied"] = {"creative": dict(cm), "profile": dict(prof)}
    return changes


# ---------------------------------------------------------------------- QC
def _finding(kind: str, severity: str, message: str, scene_idx=None,
             fix_hint: str = "", fixable: bool = False, _n: int = 0,
             **extra) -> dict:
    # Deterministic ID (stable across run_qc calls for the same project) so
    # auto_fix(project, finding_id) can re-resolve findings by re-running QC.
    tag = scene_idx if scene_idx is not None else "x"
    f = {"id": f"qc-{kind}-{tag}-{_n}", "kind": kind, "severity": severity,
         "message": message, "scene_idx": scene_idx, "fix_hint": fix_hint,
         "fixable": fixable}
    f.update(extra)
    return f


def _resolve_media(seg: dict, media_base: str | None) -> str | None:
    raw = seg.get("file") or seg.get("path") or seg.get("name")
    if not raw:
        return None
    raw = str(raw)
    if os.path.isabs(raw):
        return raw
    if media_base:
        return os.path.join(media_base, os.path.basename(raw))
    return raw


def run_qc(project: dict, media_base: str | None = None) -> list[dict]:
    """Run REAL quality checks against a project. Every check inspects
    actual data (filesystem, time intervals, geometry); nothing is faked.
    Returns a list of finding dicts:
      {id, kind, severity, message, scene_idx, fix_hint, fixable, ...}
    severity in {"error", "warning", "info"}.
    """
    findings: list[dict] = []
    _counts: dict[str, int] = {}

    def mk(kind, *a, **kw):
        _counts[kind] = _counts.get(kind, 0) + 1
        return _finding(kind, *a, _n=_counts[kind] - 1, **kw)

    if not isinstance(project, dict):
        return [mk("invalid_project", "error",
                   "Project is not a valid object.", None,
                   "Pass a project dict.", False)]

    segments = project.get("segments") or []
    subtitles = sorted(project.get("subtitles") or [],
                       key=lambda s: (s.get("start", 0), s.get("end", 0)))
    target = str(project.get("format") or "16:9")

    # 1. missing media files (real os.path.exists check)
    for seg in segments:
        idx = seg.get("index", segments.index(seg))
        path = _resolve_media(seg, media_base)
        if not path:
            findings.append(mk(
                "missing_media", "error",
                f"Scene {idx}: no media file assigned.",
                idx, "Assign footage to this scene or regenerate it.",
                False))
        elif not os.path.exists(path):
            findings.append(mk(
                "missing_media", "error",
                f"Scene {idx}: media file not found: {os.path.basename(path)}",
                idx, "Re-download the asset or pick a replacement candidate.",
                False, path=path))

    # 2. subtitle overlap (real interval math)
    for a, b in zip(subtitles, subtitles[1:]):
        a_end, b_start = a.get("end", 0), b.get("start", 0)
        if b_start < a_end - 1e-6:
            findings.append(mk(
                "subtitle_overlap", "warning",
                f"Captions overlap by {a_end - b_start:.2f}s "
                f"({a.get('start', 0):.1f}s–{a_end:.1f}s vs "
                f"{b_start:.1f}s–{b.get('end', 0):.1f}s).",
                None,
                "Auto-fix shortens the earlier caption to end where the next begins.",
                True, first_idx=subtitles.index(a),
                second_idx=subtitles.index(b)))

    # 3. aspect mismatch vs target format (real geometry)
    want_portrait = target == "9:16"
    for seg in segments:
        idx = seg.get("index", segments.index(seg))
        w, h = seg.get("width") or 0, seg.get("height") or 0
        if not w or not h:
            continue
        is_portrait = h > w * 1.05
        if is_portrait != want_portrait:
            have = "portrait" if is_portrait else "landscape"
            findings.append(mk(
                "aspect_mismatch", "warning",
                f"Scene {idx}: {have} footage ({w}x{h}) in a {target} project.",
                idx, "Reframe to 9:16, or replace with matching-orientation footage.",
                False, width=w, height=h))

    # 4. dead sections: long silences overlapping scenes
    for sil in project.get("silences") or []:
        s0, s1 = sil.get("start", 0), sil.get("end", 0)
        if s1 - s0 < 2.0:
            continue
        hit = [seg.get("index") for seg in segments
               if seg.get("start", 0) < s1 and seg.get("end", 0) > s0]
        if hit:
            findings.append(mk(
                "dead_section", "info",
                f"{s1 - s0:.1f}s of near-silence at {s0:.1f}s–{s1:.1f}s "
                f"overlaps scene(s) {hit}.",
                hit[0] if len(hit) == 1 else None,
                "Trim the silence or tighten the scene to keep pacing.",
                False, scenes=hit, start=s0, end=s1))

    # 5. repeated footage in adjacent scenes (same resolved file back-to-back)
    resolved = [_resolve_media(s, media_base) for s in segments]
    for i in range(1, len(segments)):
        a, b = resolved[i - 1], resolved[i]
        if a and b and os.path.basename(a) == os.path.basename(b):
            idx = segments[i].get("index", i)
            alt = (segments[i].get("alt_candidates") or [])
            neighbor_files = {os.path.basename(x) for x in (a, b) if x}
            swappable = any(
                os.path.basename(str(c.get("file", ""))) not in neighbor_files
                for c in alt if isinstance(c, dict))
            findings.append(mk(
                "repeat_adjacent", "warning",
                f"Scenes {segments[i-1].get('index', i-1)} and {idx} use the "
                f"same footage ({os.path.basename(a)}).",
                idx,
                ("Auto-fix swaps in an alternate candidate."
                 if swappable else
                 "No alternate candidate available — regenerate this scene."),
                swappable, prev_idx=segments[i - 1].get("index", i - 1)))

    # 6. low-confidence scenes (collected, also surfaced in the report)
    for seg in segments:
        conf = seg.get("confidence")
        if conf is None:
            continue
        try:
            conf = float(conf)
        except (TypeError, ValueError):
            continue
        if conf < 0.5:
            idx = seg.get("index", segments.index(seg))
            findings.append(mk(
                "low_confidence", "info",
                f"Scene {idx}: low match confidence ({conf:.2f}).",
                idx, "Review the footage choice for this scene manually.",
                False, confidence=conf))

    order = {"error": 0, "warning": 1, "info": 2}
    findings.sort(key=lambda f: (order.get(f["severity"], 3), f["id"]))
    return findings


def auto_fix(project: dict, finding_id: str,
             media_base: str | None = None) -> dict:
    """Apply a SAFE automatic fix for a finding produced by run_qc.

    Only kinds marked fixable are handled; anything else returns ok=False
    with an honest reason. The finding is re-resolved by re-running QC so
    the caller never needs to keep QC state.
    """
    if not isinstance(project, dict):
        return {"ok": False, "message": "Invalid project."}
    target = next((f for f in run_qc(project, media_base)
                   if f["id"] == str(finding_id)), None)
    if target is None:
        return {"ok": False, "message": f"Finding {finding_id} not found "
                "(project may have changed — re-run QC)."}
    if not target.get("fixable"):
        return {"ok": False,
                "message": f"Finding {target['kind']} has no safe auto-fix. "
                           f"Hint: {target.get('fix_hint', '')}"}

    kind = target["kind"]
    if kind == "subtitle_overlap":
        subs = project.get("subtitles") or []
        i, j = target["first_idx"], target["second_idx"]
        if 0 <= i < len(subs) and 0 <= j < len(subs):
            subs[i]["end"] = round(float(subs[j]["start"]), 3)
            return {"ok": True,
                    "message": f"Caption {i} shortened to end at "
                               f"{subs[j]['start']:.2f}s (no more overlap)."}
        return {"ok": False, "message": "Caption indices out of range."}

    if kind == "repeat_adjacent":
        segs = project.get("segments") or []
        idx = target["scene_idx"]
        seg = next((s for s in segs if s.get("index", None) == idx), None)
        if seg is None:
            return {"ok": False, "message": "Scene not found."}
        neighbor_files = set()
        for k, s in enumerate(segs):
            if abs((s.get("index", k)) - idx) == 1:
                p = _resolve_media(s, media_base)
                if p:
                    neighbor_files.add(os.path.basename(p))
        for cand in seg.get("alt_candidates") or []:
            cf = str(cand.get("file", "")) if isinstance(cand, dict) else ""
            if cf and os.path.basename(cf) not in neighbor_files:
                seg["file"] = cf
                if cand.get("width"):
                    seg["width"] = cand["width"]
                if cand.get("height"):
                    seg["height"] = cand["height"]
                return {"ok": True,
                        "message": f"Scene {idx} swapped to alternate footage "
                                   f"({os.path.basename(cf)})."}
        return {"ok": False,
                "message": "No usable alternate candidate for this scene."}

    return {"ok": False, "message": f"No auto-fix implemented for {kind}."}


# -------------------------------------------------------- completion report
LOW_CONF_THRESHOLD = 0.5


def build_report(project: dict) -> dict:
    """Completion report with REAL counts derived from the project data."""
    if not isinstance(project, dict):
        raise ValueError("project must be a dict")
    segments = project.get("segments") or []
    subtitles = project.get("subtitles") or []
    overlays = project.get("overlays") or []
    transitions = project.get("transitions") or []

    broll = sum(1 for s in segments if _origin(s) == "broll")
    user = sum(1 for s in segments if _origin(s) == "user")
    images = sum(1 for s in segments
                 if str(s.get("media_type", "")).lower() == "image")
    duration = project.get("duration") or max(
        [float(s.get("end", 0) or 0) for s in segments] + [0.0])
    trans_count = len(transitions) or sum(
        1 for s in segments if s.get("transition"))

    low_conf = []
    for s in segments:
        try:
            conf = float(s.get("confidence", 1.0))
        except (TypeError, ValueError):
            conf = 1.0
        if conf < LOW_CONF_THRESHOLD:
            low_conf.append({
                "scene_idx": s.get("index"),
                "confidence": round(conf, 3),
                "text": str(s.get("text", ""))[:120],
                "file": os.path.basename(str(s.get("file", "") or "")),
            })

    return {
        "duration": round(float(duration), 2),
        "clip_count": len(segments),
        "broll_count": broll,
        "user_clips": user,
        "images": images,
        "subtitles": len(subtitles),
        "overlays": len(overlays),
        "transitions": trans_count,
        "format": str(project.get("format") or "16:9"),
        "low_confidence": low_conf,
        "profile": (project.get("editing") or {}).get("profile"),
        "creative_mode": (project.get("editing") or {}).get("creative_mode"),
        "source_mode": (project.get("editing") or {}).get("source_mode"),
    }
