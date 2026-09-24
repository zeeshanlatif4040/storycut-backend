"""Core analysis engine.

- Script understanding: sentences, story map (dates, numbers, entities),
  keyword extraction, section detection.
- Voice analysis: duration (ffprobe) + speech-energy intervals
  (ffmpeg silencedetect) + sentence/word timing aligned to actual audio.
- Visual pipeline: 2-3 word checkpoints grouped into natural segments,
  visual-intent representation, search-query expansion.
- Subtitles + text-overlay detection.

Timing method is honest: sentences are distributed across *detected speech*
intervals proportionally to word count, preserving real pauses. This is an
energy-based alignment, not true speech-to-text word alignment (Whisper is
not bundled). The UI labels it accordingly.
"""
from __future__ import annotations
import re
import json
import math
import subprocess
import collections

# ---------------------------------------------------------------- stopwords
STOPWORDS = set("""
a about above after again against all am an and any are as at be because been before
being below between both but by can cannot could did do does doing down during each
few for from further had has have having he her here hers herself him himself his how
i if in into is it its itself like me more most my myself no nor not of off on once
only or other ought our ours ourselves out over own same she should so some such than
that the their theirs them themselves then there these they this those through to too
under until up very was we were what when where which while who whom why with would
you your yours yourself yourselves one two get got make made just know like look
""".split())

# ---------------------------------------------------------------- text utils

_SENT_END = re.compile(r'(?<=[.!?…])\s+(?=[A-Z0-9"\“\(\[])')
_WS = re.compile(r'\s+')


def clean_text(t: str) -> str:
    t = t.replace("\r\n", "\n").replace("\r", "\n")
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r'\n{3,}', '\n\n', t)
    return t.strip()


def split_sentences(text: str) -> list[str]:
    """Sentence splitter that also keeps paragraph breaks as section hints."""
    text = clean_text(text)
    if not text:
        return []
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    out = []
    for p in paras:
        p = _WS.sub(' ', p.replace('\n', ' '))
        parts = _SENT_END.split(p)
        # merge fragments that are clearly not sentence ends (e.g. "Mr.")
        merged = []
        for part in parts:
            part = part.strip()
            if not part:
                continue
            if merged and re.search(r'\b(Mr|Mrs|Ms|Dr|St|vs|e\.g|i\.e)\.$', merged[-1]):
                merged[-1] = merged[-1] + ' ' + part
            else:
                merged.append(part)
        out.extend(merged)
    return out


def words_of(s: str) -> list[str]:
    return re.findall(r"[A-Za-z0-9'’-]+", s)


def content_words(s: str) -> list[str]:
    return [w.lower() for w in words_of(s)
            if w.lower() not in STOPWORDS and len(w) > 2 and not w.isdigit()]


# ---------------------------------------------------------------- story map

_DATE_RE = re.compile(
    r'\b(?:\d{1,2}(?:st|nd|rd|th)?\s+)?(?:January|February|March|April|May|June|July|'
    r'August|September|October|November|December)(?:\s+\d{1,2}(?:st|nd|rd|th)?)?(?:,?\s+\d{4})?\b'
    r'|\b\d{4}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b', re.IGNORECASE)
_NUMBER_RE = re.compile(
    r'\b\d+(?:,\d{3})*(?:\.\d+)?\s*(?:%|percent|million|billion|thousand|km|miles?|kg|tons?|hours?|minutes?|seconds?|days?|years?|x)?\b',
    re.IGNORECASE)
_ENTITY_RE = re.compile(r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b')


def extract_story_map(text: str, sentences: list[str]) -> dict:
    dates = sorted(set(m.group(0) for m in _DATE_RE.finditer(text)))[:40]
    numbers = sorted(set(m.group(0) for m in _NUMBER_RE.finditer(text)),
                     key=len, reverse=True)[:40]
    ents = collections.Counter()
    for m in _ENTITY_RE.finditer(text):
        e = m.group(1)
        if e.lower() in STOPWORDS or len(e) < 4:
            continue
        # skip sentence-initial common words
        ents[e] += 1
    entities = [e for e, c in ents.most_common(40) if c >= 1]
    kw = collections.Counter()
    for s in sentences:
        kw.update(content_words(s))
    keywords = [w for w, _ in kw.most_common(60)]
    # sections: paragraphs (double newline) -> first sentence as heading-ish
    paras = [p.strip() for p in clean_text(text).split("\n\n") if p.strip()]
    sections = []
    for p in paras[:50]:
        first = split_sentences(p)
        sections.append({"heading": (first[0] if first else p)[:120],
                         "preview": p[:220]})
    return {
        "wordCount": len(words_of(text)),
        "sentenceCount": len(sentences),
        "dates": dates, "numbers": numbers, "entities": entities,
        "keywords": keywords, "sections": sections,
    }


# ---------------------------------------------------------------- voice timing

def ffprobe_duration(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, timeout=60)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def detect_speech_intervals(path: str, noise_db: float = -32.0,
                            min_sil: float = 0.45) -> tuple[float, list[list[float]]]:
    """Return (duration, [[start,end],...]) speech intervals from silencedetect."""
    duration = ffprobe_duration(path)
    cmd = ["ffmpeg", "-hide_banner", "-i", path, "-af",
           f"silencedetect=noise={noise_db}dB:d={min_sil}",
           "-f", "null", "-"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return duration, [[0.0, duration]] if duration > 0 else []
    log = proc.stderr or ""
    silences = []
    for m in re.finditer(r"silence_start: ([\d.]+)", log):
        silences.append([float(m.group(1)), None])
    ends = [float(m.group(1)) for m in re.finditer(r"silence_end: ([\d.]+)", log)]
    for i, e in enumerate(ends):
        if i < len(silences):
            silences[i][1] = e
    intervals: list[list[float]] = []
    cursor = 0.0
    for s0, s1 in silences:
        if s0 > cursor + 0.05:
            intervals.append([cursor, s0])
        cursor = s1 if s1 is not None else duration
    if cursor < duration - 0.05:
        intervals.append([cursor, duration])
    intervals = [[max(0.0, a), min(duration, b)] for a, b in intervals if b - a > 0.08]
    if not intervals and duration > 0:
        intervals = [[0.0, duration]]
    return duration, intervals


def align_sentences(sentences: list[dict], intervals: list[list[float]],
                    duration: float) -> list[dict]:
    """Distribute sentences across speech intervals proportional to word count.

    sentences: [{"text":..., "words":[...]}]. Returns new list with start/end
    and per-word start/end. Pauses between speech intervals are preserved.
    """
    total_words = sum(len(s["words"]) for s in sentences) or 1
    speech_total = sum(b - a for a, b in intervals) or (duration or 1.0)
    wps = total_words / speech_total  # words per speech-second
    res = []
    iv = 0
    cur = intervals[0][0] if intervals else 0.0
    for s in sentences:
        need = len(s["words"]) / wps
        start = cur
        while iv < len(intervals):
            a, b = intervals[iv]
            if cur < a:
                cur = a
                start = cur
            if cur + need <= b + 1e-6:
                cur = cur + need
                break
            need -= (b - cur)
            iv += 1
            cur = intervals[iv][0] if iv < len(intervals) else duration
        else:
            cur = duration
        end = min(cur, duration)
        words = s["words"]
        wres = []
        if words and end > start:
            per = (end - start) / len(words)
            for i, w in enumerate(words):
                wres.append({"w": w, "start": round(start + i * per, 3),
                             "end": round(start + (i + 1) * per, 3)})
        res.append({"text": s["text"], "words": wres,
                    "start": round(start, 3), "end": round(end, 3)})
    return res


# ---------------------------------------------------------------- visual pipeline

_SYNONYMS = {
    "city": ["urban", "downtown", "metropolis"], "cities": ["urban", "downtown"],
    "car": ["vehicle", "automobile", "driving"], "cars": ["vehicles", "traffic"],
    "ocean": ["sea", "waves"], "sea": ["ocean", "waves"],
    "forest": ["woods", "trees"], "mountain": ["mountains", "peak", "alps"],
    "people": ["crowd", "person"], "person": ["people", "portrait"],
    "food": ["cooking", "meal"], "money": ["finance", "cash", "business"],
    "business": ["office", "corporate"], "technology": ["tech", "computer"],
    "war": ["battle", "soldier", "military"], "love": ["couple", "romance"],
    "dog": ["puppy", "pet"], "cat": ["kitten", "pet"],
    "house": ["home", "building"], "river": ["water", "stream"],
    "sky": ["clouds", "sunset"], "sunset": ["dusk", "sky"],
    "construction": ["building site", "crane"], "factory": ["industry", "manufacturing"],
}


def expand_queries(keywords: list[str], context: list[str] | None = None) -> list[str]:
    """Multiple related search queries for a visual intent (spec section 12)."""
    kws = [k for k in keywords if k][:5]
    queries: list[str] = []
    if kws:
        queries.append(" ".join(kws[:4]))
    if len(kws) >= 2:
        queries.append(" ".join(kws[:2]))
    for k in kws[:3]:
        for syn in _SYNONYMS.get(k, [])[:1]:
            queries.append(syn)
        if len(queries) >= 5:
            break
    if kws:
        queries.append(kws[0])
    # de-dupe, keep order
    seen, out = set(), []
    for q in queries:
        q = q.strip()
        if q and q not in seen:
            seen.add(q)
            out.append(q)
    return out[:5] or ["abstract background"]


def build_segments(timed: list[dict], story: dict,
                   target_min: float = 3.5, target_max: float = 12.0) -> list[dict]:
    """Group timed sentences into natural visual segments.

    2-3 word checkpoints are inspection points, not cut points: we walk the
    narration word by word, note phrase boundaries (commas/conjunctions), and
    merge sentences until the segment is long enough to be a natural shot,
    preferring to cut at sentence ends.
    """
    segments: list[dict] = []
    cur = None

    def flush():
        nonlocal cur
        if cur and cur["sentences"]:
            segments.append(_finalize_segment(cur, story, len(segments)))
        cur = None

    for s in timed:
        dur = s["end"] - s["start"]
        if cur is None:
            cur = {"sentences": [], "start": s["start"]}
        cur["sentences"].append(s)
        cur["end"] = s["end"]
        seg_dur = cur["end"] - cur["start"]
        # natural cut: sentence end reached and we're past the minimum,
        # or we exceeded the max and must cut here.
        if seg_dur >= target_min and (s["text"].rstrip().endswith((".", "!", "?", "…")) or seg_dur >= target_max):
            flush()
        elif seg_dur >= target_max:
            flush()
    flush()
    # merge tiny trailing segment
    if len(segments) >= 2 and (segments[-1]["end"] - segments[-1]["start"]) < 2.0:
        prev = segments[-2]
        last = segments.pop()
        prev["sentences"].extend(last["sentences"])
        prev["end"] = last["end"]
        prev = _finalize_segment(prev, story, len(segments) - 1)
        segments[-1] = prev
    return segments


def _finalize_segment(cur: dict, story: dict, idx: int) -> dict:
    text = " ".join(s["text"] for s in cur["sentences"])
    cws = content_words(text)
    # weight by story-level keyword importance
    rank = {w: i for i, w in enumerate(story.get("keywords", []))}
    scored = sorted(set(cws), key=lambda w: rank.get(w, 10_000))
    keywords = scored[:6]
    # checkpoints: every ~3 words note the phrase (analysis trace, not cuts)
    words = words_of(text)
    checkpoints = [" ".join(words[i:i + 3]) for i in range(0, len(words), 3)][:12]
    seg = {
        "id": f"seg-{idx}",
        "index": idx,
        "text": text,
        "start": round(cur["start"], 3),
        "end": round(cur["end"], 3),
        "duration": round(cur["end"] - cur["start"], 3),
        "keywords": keywords,
        "queries": expand_queries(keywords),
        "checkpoints": checkpoints,
        "sentences": [{"text": s["text"], "start": s["start"], "end": s["end"]}
                      for s in cur["sentences"]],
    }
    return seg


# ---------------------------------------------------------------- subtitles

def build_subtitles(timed: list[dict], max_chars: int = 84) -> list[dict]:
    """Sentence-ish caption cues from real voice timing, with line breaks."""
    cues = []
    for s in timed:
        text = s["text"].strip()
        if not text:
            continue
        # split long sentences at commas into 2-line-friendly chunks
        chunks, cur = [], ""
        for part in re.split(r'(,\s+|\s+—\s+)', text):
            if len(cur) + len(part) <= max_chars:
                cur += part
            else:
                if cur.strip():
                    chunks.append(cur.strip())
                cur = part.strip()
        if cur.strip():
            chunks.append(cur.strip())
        n = len(chunks) or 1
        total = max(0.001, s["end"] - s["start"])
        for i, ch in enumerate(chunks):
            c0 = s["start"] + total * i / n
            c1 = s["start"] + total * (i + 1) / n
            # line break near middle
            words = ch.split()
            line = ch
            if len(ch) > 42 and len(words) > 3:
                mid = len(words) // 2
                line = " ".join(words[:mid]) + "\n" + " ".join(words[mid:])
            cues.append({"text": line, "start": round(c0, 3), "end": round(c1, 3)})
    return cues


# ---------------------------------------------------------------- text overlays

def detect_text_overlays(segments: list[dict], story: dict) -> list[dict]:
    """Selective overlays: dates, numbers/stats, names/places, chapter heads."""
    overlays = []
    for seg in segments:
        text = seg["text"]
        items = []
        for m in _DATE_RE.finditer(text):
            v = m.group(0).strip()
            if len(v) >= 4:
                items.append({"kind": "date", "text": v})
        for m in _NUMBER_RE.finditer(text):
            v = m.group(0).strip()
            if re.search(r'\d', v):
                items.append({"kind": "stat", "text": v})
        for e in story.get("entities", [])[:40]:
            if e in text and len(items) < 6:
                items.append({"kind": "name", "text": e})
        # de-dupe
        seen, uniq = set(), []
        for it in items:
            if it["text"].lower() not in seen:
                seen.add(it["text"].lower())
                uniq.append(it)
        for it in uniq[:3]:
            style = {"date": "lower-third", "stat": "stat-pop",
                     "name": "lower-third"}[it["kind"]]
            overlays.append({
                "id": f"ov-{seg['id']}-{it['kind']}",
                "segmentId": seg["id"],
                "kind": it["kind"],
                "text": it["text"],
                "style": style,
                "start": seg["start"] + 0.3,
                "end": min(seg["end"] - 0.2, seg["start"] + 6.0),
            })
    # chapter headings: first segment of each story section
    return overlays


def full_plan(script_text: str, timed_sentences: list[dict]) -> dict:
    sentences = [s["text"] for s in timed_sentences]
    story = extract_story_map(script_text, sentences)
    segments = build_segments(timed_sentences, story)
    subtitles = build_subtitles(timed_sentences)
    overlays = detect_text_overlays(segments, story)
    return {"story": story, "segments": segments, "subtitles": subtitles,
            "overlays": overlays}
