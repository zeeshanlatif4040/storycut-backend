"""Creative Director & Story Intelligence — rule-based, deterministic.

Every decision below is a transparent rule over the script text and the
voice-aligned timing (start/end per sentence). There is no ML, no ASR, no
external API call, and no randomness: the same input always produces the
same output. The UI must label these results as "rule-based", never as AI
understanding.

Public API (all pure functions):
  build_story_map(script_text, timed_sentences) -> dict
  score_candidate(candidate, unit)             -> (score 0-100, reasons)
  explain_choice(candidate, unit)              -> str
  assign_confidence(unit, chosen)               -> {"level", "reasons"}
"""
from __future__ import annotations
import re

METHOD = "rule-based"

# ------------------------------------------------------------------ tokenize
_STOPWORDS = frozenset("""
a an the and or but if then else when while of at by for with about into
through during before after above below to from up down in out on off over
under again further once here there all any both each few more most other
some such no nor not only own same so than too very can will just don should
now i me my we our you your he him his she her it its they them their this
that these those am is are was were be been being have has had having do
does did doing would could ought as because until what which who whom how
why where whom whose let's let s t don ve re ll m d
""".split())

_SENT_SPLIT = re.compile(r"(?<=[.!?…])\s+(?=[A-Z0-9\"'“‘(\[])")
_WORD = re.compile(r"[a-z0-9]+(?:'[a-z]+)?")


def _split_sentences(text: str) -> list[str]:
    parts = [p.strip() for p in _SENT_SPLIT.split(text.strip()) if p.strip()]
    return parts or ([text.strip()] if text.strip() else [])


def _words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def _content_words(text: str) -> list[str]:
    return [w for w in _words(text) if w not in _STOPWORDS and len(w) > 2]


# ------------------------------------------------------------------- entities
_DATE_RE = re.compile(
    r"\b(?:\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{2,4}"
    r"|(?:19|20)\d{2}s?)\b", re.I)
_NUMBER_RE = re.compile(
    r"\b\$?\d+(?:,\d{3})*(?:\.\d+)?%?\b|\b\d+\s?(?:million|billion|thousand|percent|%)\b", re.I)
_NAME_RE = re.compile(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b")
_SINGLE_NAME_RE = re.compile(r"\b([A-Z][a-z]{3,})\b")
_NAME_BLOCKLIST = frozenset(
    "The This That These Those Here There When Where What Which While With From".split())


def extract_entities(text: str) -> list[dict]:
    """Regex + capitalization heuristics. Kinds: date, number, name.
    This is pattern matching, not NER — it can miss or mislabel."""
    found: list[dict] = []
    seen = set()

    def add(kind: str, value: str):
        key = (kind, value.lower())
        if value and key not in seen:
            seen.add(key)
            found.append({"kind": kind, "value": value})

    for m in _DATE_RE.finditer(text):
        add("date", m.group(0))
    for m in _NUMBER_RE.finditer(text):
        add("number", m.group(0))
    for m in _NAME_RE.finditer(text):
        v = m.group(1)
        if v.split()[0] not in _NAME_BLOCKLIST:
            add("name", v)
    # Single capitalized words only if they repeat (likely a real name/place).
    counts: dict[str, int] = {}
    for m in _SINGLE_NAME_RE.finditer(text):
        v = m.group(1)
        if v in _NAME_BLOCKLIST:
            continue
        counts[v] = counts.get(v, 0) + 1
    for v, n in counts.items():
        if n >= 2 and not any(v in e["value"] for e in found):
            add("name", v)
    return found


# ----------------------------------------------------------------------- mood
_MOODS = {
    "serious": ["crisis", "danger", "risk", "threat", "warning", "urgent",
                "critical", "problem", "fail", "loss", "death", "war"],
    "emotional": ["love", "heart", "tears", "cry", "feel", "hope", "dream",
                  "believe", "soul", "pain", "joy", "fear", "brave"],
    "energetic": ["amazing", "incredible", "wow", "fast", "power", "win",
                  "champion", "epic", "boom", "let's go", "unstoppable",
                  "exciting", "rush"],
    "educational": ["learn", "how to", "step", "guide", "tutorial", "explain",
                    "because", "reason", "example", "tips", "lesson", "study"],
    "documentary": ["history", "century", "ancient", "discovered", "research",
                    "scientists", "evidence", "archive", "decades", "journey"],
    "corporate": ["business", "company", "market", "revenue", "growth",
                  "strategy", "customers", "brand", "invest", "profit",
                  "quarter", "startup"],
}


def infer_mood(text: str) -> dict:
    words = _words(text)
    joined = " ".join(words)
    scores = {}
    for mood, kws in _MOODS.items():
        hits = sum(1 for k in kws if k in joined)
        scores[mood] = hits
    total = sum(scores.values())
    best = max(scores, key=lambda m: (scores[m], m))
    return {
        "mood": best if total else "neutral",
        "scores": scores,
        "method": METHOD,
        "note": ("keyword-lexicon match only; ties broken alphabetically, "
                 "not by understanding") if total else "no lexicon hits",
    }


# ------------------------------------------------------------------ grouping
_CTA_KEYWORDS = ["subscribe", "follow", "comment", "share", "click", "link",
                 "download", "buy", "try", "join", "visit", "sign up",
                 "check out", "description", "bell", "notification"]
_IMPERATIVES = {"watch", "look", "listen", "remember", "imagine", "think",
                "ask", "tell", "get", "grab", "start", "stop", "hit",
                "smash", "drop", "leave"}


def _is_cta(sentence: str) -> bool:
    low = sentence.lower()
    if sentence.strip().endswith("?"):
        return True
    if any(k in low for k in _CTA_KEYWORDS):
        return True
    first = (_words(sentence) or [""])[0]
    return first in _IMPERATIVES


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _group_units(sentences: list[dict]) -> list[list[dict]]:
    """Group consecutive sentences into semantic units by topic-word overlap.

    Units are sentence-based (never word fragments). A sentence joins the
    current unit when it shares >= 2 content words or Jaccard >= 0.18 with
    the unit's vocabulary; otherwise a new unit starts. Very long units are
    split at 45 words to keep B-roll cuts watchable.
    """
    units: list[list[dict]] = []
    for s in sentences:
        cw = set(_content_words(s["text"]))
        if units:
            uvocab: set[str] = set()
            for u in units[-1]:
                uvocab |= set(_content_words(u["text"]))
            uwords = sum(len(_content_words(u["text"])) for u in units[-1])
            shared = len(cw & uvocab)
            if (shared >= 2 or _jaccard(cw, uvocab) >= 0.18) and uwords < 45:
                units[-1].append(s)
                continue
        units.append([s])
    return units


_STATIC_RISK_SECONDS = 12.0   # unit with no cut for this long reads as static
_RUSHED_SECONDS = 2.0         # unit shorter than this feels rushed


def build_story_map(script_text: str, timed_sentences: list[dict]) -> dict:
    """Build the story map. timed_sentences is a list of
    {text, start, end} from voice analysis; when empty or shorter than the
    script, timing falls back to an even split of a 0-duration timeline and
    durations are reported as estimated.

    Returns dict with hook/body/cta sections, per-unit timing, entities,
    mood, pacing flags and boring-scene signals. All rule-based.
    """
    script_sentences = _split_sentences(script_text or "")
    timed = list(timed_sentences or [])

    # Align script sentences with timing rows by position.
    rows: list[dict] = []
    for i, text in enumerate(script_sentences):
        t = timed[i] if i < len(timed) else {}
        try:
            start = float(t.get("start", 0) or 0)
            end = float(t.get("end", 0) or 0)
        except (TypeError, ValueError):
            start, end = 0.0, 0.0
        rows.append({"text": text, "start": start, "end": end})
    timing_real = bool(timed) and any(r["end"] > r["start"] for r in rows)

    n = len(rows)
    hook_rows = rows[:2] if n > 3 else rows[:1]
    cta_rows = [rows[-1]] if n > 2 and _is_cta(rows[-1]["text"]) else []
    body_rows = rows[len(hook_rows): n - len(cta_rows)]

    units: list[dict] = []
    uid = 0

    def make_unit(kind: str, sents: list[dict]) -> dict:
        nonlocal uid
        uid += 1
        text = " ".join(s["text"] for s in sents)
        start = min((s["start"] for s in sents), default=0.0)
        end = max((s["end"] for s in sents), default=0.0)
        duration = round(max(0.0, end - start), 2)
        entities = extract_entities(text)
        words = _words(text)
        density = (len(entities) / max(1, len(words))) * 100  # per 100 words
        flags: list[str] = []
        if duration >= _STATIC_RISK_SECONDS:
            flags.append("static-risk")
        if 0 < duration < _RUSHED_SECONDS:
            flags.append("rushed")
        if density < 1.0 and duration >= 10.0:
            flags.append("boring-risk")
        query = " ".join(_content_words(text)[:6])
        return {
            "id": f"u{uid}",
            "type": kind,
            "text": text,
            "sentences": [s["text"] for s in sents],
            "start": round(start, 2),
            "end": round(end, 2),
            "duration": duration,
            "entities": entities,
            "entityDensity": round(density, 2),
            "flags": flags,
            "searchQuery": query,
            "preferredOrientation": "landscape",
        }

    for h in ([hook_rows] if hook_rows else []):
        units.append(make_unit("hook", h))
    for grp in _group_units(body_rows):
        units.append(make_unit("body", grp))
    if cta_rows:
        units.append(make_unit("cta", cta_rows))

    # Renumber sentence indices for the UI.
    for i, u in enumerate(units):
        u["index"] = i

    return {
        "method": METHOD,
        "timingReal": timing_real,
        "timingNote": ("voice-aligned timing" if timing_real
                       else "no voice timing supplied; durations estimated as 0"),
        "hook": [u["id"] for u in units if u["type"] == "hook"],
        "cta": [u["id"] for u in units if u["type"] == "cta"],
        "units": units,
        "mood": infer_mood(script_text or ""),
        "ctaDetected": bool(cta_rows),
        "sentenceCount": n,
        "unitCount": len(units),
    }


# ------------------------------------------------------------------- scoring
_COMMERCIAL_OK_LICENSES = {
    "cc0", "public domain", "pdm",
    "pexels license", "pexels",
    "pixabay license", "pixabay", "pixabay content license",
    "unsplash license", "unsplash",
}


def _license_ok(candidate: dict) -> bool:
    if candidate.get("license_commercial_ok") is True:
        return True
    lic = str(candidate.get("license", "")).lower()
    return any(k in lic for k in _COMMERCIAL_OK_LICENSES)


def _resolution_label(candidate: dict) -> str:
    w = candidate.get("file_width") or candidate.get("width") or 0
    h = candidate.get("file_height") or candidate.get("height") or 0
    return f"{w}x{h}" if w and h else "unknown"


def score_candidate(candidate: dict, unit: dict) -> tuple[float, list[str]]:
    """Rank one candidate for one story unit. Returns (score 0-100, reasons).

    Weights: resolution 30, orientation 20, keyword overlap 20,
    license commercial-ok 15, provider priority 15.
    """
    reasons: list[str] = []
    c = candidate or {}
    u = unit or {}

    # Resolution (0-30): full credit at 1080p, scaled by pixel count.
    w = c.get("file_width") or c.get("width") or 0
    h = c.get("file_height") or c.get("height") or 0
    res_score = min(1.0, (w * h) / (1920 * 1080)) if w and h else 0.0
    if w and h:
        reasons.append(f"resolution {_resolution_label(c)} "
                       f"({'1080p+' if w * h >= 1920 * 1080 else 'below 1080p'})")
    else:
        reasons.append("resolution unknown")

    # Orientation (0-20).
    want = (u.get("preferredOrientation") or "landscape").lower()
    got = str(c.get("orientation", "")).lower()
    if not got and w and h:
        got = "landscape" if w >= h else "portrait"
    orient_score = 1.0 if got == want else 0.0
    reasons.append(f"orientation {got or 'unknown'} "
                   f"({'matches' if orient_score else 'mismatch'}: want {want})")

    # Keyword overlap with unit text (0-20).
    qterms = [t for t in _content_words(u.get("text", ""))]
    hay = f"{c.get('title', '')} {' '.join((c.get('raw') or {}).get('tags', []) or [])} " \
          f"{c.get('query', '')}".lower()
    overlap = (sum(1 for t in set(qterms) if t in hay) / max(1, len(set(qterms)))) \
        if qterms else 0.0
    reasons.append(f"keyword overlap {overlap:.0%} with unit text")

    # License (0-15).
    lic_ok = _license_ok(c)
    reasons.append(f"license '{c.get('license', 'unknown')}' "
                   f"({'commercial-ok' if lic_ok else 'not verified commercial-ok'})")

    # Provider priority (0-15): lower number = higher priority in settings.
    prio = c.get("provider_priority", 50)
    try:
        prio = float(prio)
    except (TypeError, ValueError):
        prio = 50.0
    prio_score = max(0.0, min(1.0, 1.0 - prio / 100.0))
    reasons.append(f"provider {c.get('provider', 'unknown')} "
                   f"priority {prio:g}")

    score = round(30 * res_score + 20 * orient_score + 20 * overlap
                  + 15 * (1.0 if lic_ok else 0.0) + 15 * prio_score, 1)
    return score, reasons


def explain_choice(candidate: dict, unit: dict) -> str:
    """Human-readable 'why this visual', built only from real metadata."""
    c = candidate or {}
    u = unit or {}
    res = _resolution_label(c)
    creator = c.get("creator") or c.get("photographer") or "unknown creator"
    lic = c.get("license", "unknown license")
    prov = c.get("provider", "unknown provider")
    query = c.get("query") or (u.get("searchQuery") or "the scene")
    orient = c.get("orientation", "")
    bits = [
        f"Chosen for “{u.get('id', 'unit')}” because it matched the search "
        f"“{query}”.",
        f"Source: {prov}, {res}{f' ({orient})' if orient else ''}, "
        f"by {creator}.",
        f"License: {lic}"
        f"{' — commercial use ok' if _license_ok(c) else ' — verify commercial use'}."
        + (" Attribution required — credit the creator."
           if c.get("attribution_required") else ""),
    ]
    return " ".join(bits)


def assign_confidence(unit: dict, chosen: dict | None) -> dict:
    """High/Medium/Low from score thresholds, downgraded by pacing flags."""
    u = unit or {}
    score = float((chosen or {}).get("score", 0) or 0)
    if score >= 75:
        level, why = "High", f"score {score:g} ≥ 75"
    elif score >= 50:
        level, why = "Medium", f"score {score:g} ≥ 50"
    else:
        level, why = "Low", f"score {score:g} < 50"
    reasons = [why] if chosen else ["no visual assigned yet"]
    flags = u.get("flags", [])
    if chosen and any(f in flags for f in ("static-risk", "boring-risk")):
        level = {"High": "Medium", "Medium": "Low", "Low": "Low"}[level]
        reasons.append("downgraded one level: unit flagged "
                       + ", ".join(f for f in flags
                                    if f in ("static-risk", "boring-risk")))
    return {"level": level, "score": score, "reasons": reasons,
            "method": METHOD}
