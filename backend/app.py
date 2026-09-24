"""AI B-Roll Finder + Auto Editor — Flask backend.

Serves the frontend and exposes the real processing APIs:
script/voice analysis, provider search with caching + fallback + ranking,
media upload/analysis, project save/load, and FFmpeg export jobs.
"""
from __future__ import annotations
import os
import re
import json
import time
import shutil
import urllib.request
import threading
from dataclasses import asdict
from flask import Flask, request, jsonify, send_file, send_from_directory

from . import analysis, store, media as media_lib, export as export_mod
from .providers import registry
from . import director_routes
from . import editing_routes
from . import audiofx_routes
from .metrics import register_metrics

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND = os.path.join(BASE, "frontend")

app = Flask(__name__, static_folder=FRONTEND, static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 900 * 1024 * 1024

# CORS for split deployments (frontend on Netlify, backend elsewhere).
# Set STORYCUT_CORS to a comma-separated list of allowed origins, e.g.
#   STORYCUT_CORS="https://your-site.netlify.app"
_CORS = [o.strip() for o in os.environ.get("STORYCUT_CORS", "").split(",") if o.strip()]


@app.before_request
def _cors_preflight():
    if request.method == "OPTIONS" and _CORS:
        return ("", 204)


@app.after_request
def _cors_headers(resp):
    if _CORS:
        origin = request.headers.get("Origin", "")
        if "*" in _CORS or origin in _CORS:
            resp.headers["Access-Control-Allow-Origin"] = origin or "*"
            resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
            resp.headers["Access-Control-Allow-Methods"] = "GET,POST,DELETE,OPTIONS"
    return resp

_rate_guard: dict[str, float] = {}
_rate_lock = threading.Lock()
# Persistent provider cooldowns after HTTP 429 (spec: rate-limit handling).
_cooldowns: dict[str, float] = {}


def _in_cooldown(provider: str) -> bool:
    with _rate_lock:
        return time.time() < _cooldowns.get(provider, 0)


def _set_cooldown(provider: str, seconds: float = 120):
    with _rate_lock:
        _cooldowns[provider] = max(_cooldowns.get(provider, 0),
                                   time.time() + seconds)


# ------------------------------------------------------------------ helpers
def err(msg, code=400):
    return jsonify({"ok": False, "error": msg}), code


def _guard(provider: str, min_interval: float = 0.4):
    with _rate_lock:
        last = _rate_guard.get(provider, 0)
        wait = min_interval - (time.time() - last)
        if wait > 0:
            time.sleep(wait)
        _rate_guard[provider] = time.time()


def rank_candidates(cands: list[dict], query: str, need_duration: float,
                    used_ids: list[str], media_type: str = "video") -> list[dict]:
    """Spec section 19 ranking: relevance, orientation, resolution, duration,
    quality, uniqueness. Penalizes repeats, wrong orientation, low res."""
    qterms = [t for t in re.findall(r"[a-z0-9]+", query.lower()) if len(t) > 2]
    used = set(used_ids or [])
    scored = []
    for c in cands:
        text = f"{c.get('title','')} {' '.join((c.get('raw') or {}).get('tags', []))}".lower()
        overlap = sum(1 for t in qterms if t in text) / max(1, len(qterms))
        res = (c.get("file_width", 0) or 0) * (c.get("file_height", 0) or 0)
        res_score = min(1.0, res / (1920 * 1080))
        dur = c.get("duration", 0) or 0
        if media_type == "image" or c.get("media_type") == "image":
            dur_score = 1.0  # still images have no duration to score
        elif need_duration > 0:
            dur_score = 1.0 if dur >= need_duration else max(0.0, dur / need_duration)
            if dur > need_duration * 6:
                dur_score *= 0.85  # excessively long stock clips waste trim time
        else:
            dur_score = 1.0 if 4 <= dur <= 40 else 0.6
        uniq = 0.0 if f"{c.get('provider')}:{c.get('asset_id')}" in used else 1.0
        score = (0.45 * overlap + 0.20 * res_score + 0.15 * dur_score
                 + 0.20 * uniq)
        c = dict(c)
        c["score"] = round(score, 3)
        c["match"] = {"keyword": round(overlap, 2), "resolution": round(res_score, 2),
                      "duration": round(dur_score, 2), "unique": bool(uniq)}
        scored.append(c)
    scored.sort(key=lambda c: c["score"], reverse=True)
    return scored


def _provider_chain():
    cfg = store.get_provider_settings()
    chain = []
    for key in registry.implemented_keys():
        c = cfg.get(key, {})
        if c.get("enabled", True) and not _in_cooldown(key):
            chain.append((int(c.get("priority", 50)), key, c.get("api_key", "")))
    chain.sort(key=lambda t: t[0])
    return [(k, key) for k, key, _ in chain]


def _cached_candidate(provider: str, asset_id: str, query: str,
                      orientation: str, media_type: str) -> dict | None:
    """Resolve a candidate from the server-side search cache (never trust a
    client-supplied file_url for providers whose CDN hosts vary)."""
    payload, hit = store.cache_get(provider, query, orientation, media_type)
    if not hit:
        return None
    for c in payload or []:
        if str(c.get("asset_id")) == str(asset_id):
            return c
    return None


# ------------------------------------------------------------------- pages
@app.get("/")
def index():
    return send_from_directory(FRONTEND, "index.html")


@app.get("/favicon.ico")
def favicon():
    """Serve the same SVG mark as the inline <link rel=icon>.

    Some browsers still request /favicon.ico even with a data: URI icon;
    without this route every page load logs a console 404.
    """
    svg = ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>"
           "<text y='.9em' font-size='90'>\u2702\ufe0f</text></svg>")
    return app.response_class(svg, mimetype="image/svg+xml")


# ------------------------------------------------------------------ uploads
@app.post("/api/uploads")
def uploads():
    """Multipart files -> validated storage + probe + thumbnail. kind=media|voice."""
    kind = request.form.get("kind", "media")
    allowed = (media_lib.ALLOWED_VIDEO | media_lib.ALLOWED_IMAGE
               if kind == "media" else media_lib.ALLOWED_AUDIO)
    out = []
    for f in request.files.getlist("files"):
        ext = os.path.splitext(f.filename or "")[1].lower()
        if ext not in allowed:
            return err(f"File type not allowed: {f.filename}")
        name = store.new_id("up") + "_" + media_lib.sanitize(f.filename)
        dest = store.safe_join(store.DIRS["uploads"], name)
        f.save(dest)
        if os.path.getsize(dest) > media_lib.MAX_BYTES:
            os.remove(dest)
            return err(f"File too large: {f.filename}")
        info = media_lib.probe(dest)
        meta = {"name": name, "original": f.filename, "kind": media_lib.kind_of(ext),
                "ext": ext, "size": os.path.getsize(dest),
                "width": info["width"], "height": info["height"],
                "duration": round(info["duration"], 2),
                "orientation": ("portrait" if info["height"] > info["width"] * 1.05
                                else "landscape" if info["width"] else "unknown")}
        if kind == "voice":
            # Real content validation (not just the extension). Rejects
            # corrupt / non-audio files with a useful message and cleans up.
            ok, emsg, ameta = media_lib.validate_audio(dest)
            if not ok:
                try:
                    os.remove(dest)
                except OSError:
                    pass
                return err(f"Audio upload failed — {emsg}. Please try again "
                           f"with a valid file.", 400)
            meta["audio"] = ameta
            store.log_event("voice_validated", name=name,
                            duration=meta["duration"], **ameta)
        if meta["kind"] == "video":
            thumb = name + ".jpg"
            if media_lib.make_thumbnail(dest, store.safe_join(store.DIRS["uploads"], thumb)):
                meta["thumb"] = thumb
            meta["scenes"] = media_lib.scene_moments(dest)[:20]
        elif meta["kind"] == "image":
            thumb = name + ".jpg"
            if media_lib.make_thumbnail(dest, store.safe_join(store.DIRS["uploads"], thumb), at=0):
                meta["thumb"] = thumb
        store.log_event("upload", kind=meta["kind"], name=name,
                        bytes=meta["size"])
        out.append(meta)
    return jsonify({"ok": True, "files": out})


@app.post("/api/media/analyze")
def media_analyze():
    name = (request.json or {}).get("name", "")
    path = store.safe_join(store.DIRS["uploads"], os.path.basename(name))
    if not os.path.exists(path):
        return err("file not found", 404)
    return jsonify({"ok": True, "scenes": media_lib.scene_moments(path),
                    "probe": media_lib.probe(path)})


@app.get("/api/media/file")
def media_file():
    name = os.path.basename(request.args.get("name", ""))
    path = store.safe_join(store.DIRS["uploads"], name)
    if not os.path.exists(path):
        return err("file not found", 404)
    return send_file(path)


@app.get("/api/media/thumb")
def media_thumb():
    name = os.path.basename(request.args.get("name", ""))
    path = store.safe_join(store.DIRS["uploads"], name)
    if not os.path.exists(path):
        return err("not found", 404)
    return send_file(path, mimetype="image/jpeg")


@app.post("/api/voice/peaks")
def voice_peaks():
    name = os.path.basename((request.json or {}).get("name", ""))
    path = store.safe_join(store.DIRS["uploads"], name)
    if not os.path.exists(path):
        return err("file not found", 404)
    buckets = min(1200, max(200, int(request.json.get("buckets", 600))))
    return jsonify({"ok": True, "peaks": media_lib.audio_peaks(path, buckets)})


# ----------------------------------------------------------------- analysis
@app.post("/api/script/analyze")
def script_analyze():
    script = (request.json or {}).get("script", "")
    if not script or not script.strip():
        return err("empty script")
    if len(analysis.words_of(script)) > 10000:
        return err("script exceeds 10,000 words")
    sentences = analysis.split_sentences(script)
    story = analysis.extract_story_map(script, sentences)
    return jsonify({"ok": True, "story": story,
                    "sentenceCount": len(sentences)})


@app.post("/api/voice/analyze")
def voice_analyze():
    """Real voice timing: ffprobe duration + silencedetect speech intervals,
    sentences distributed across speech by word count (energy alignment)."""
    data = request.json or {}
    name = os.path.basename(data.get("audioName", ""))
    script = data.get("script", "")
    path = store.safe_join(store.DIRS["uploads"], name)
    if not os.path.exists(path):
        return err("audio file not found", 404)
    t0 = time.time()
    duration, intervals = analysis.detect_speech_intervals(path)
    sentences = analysis.split_sentences(script)
    timed = analysis.align_sentences(
        [{"text": s, "words": analysis.words_of(s)} for s in sentences],
        intervals, duration)
    store.log_event("voice_analyzed", duration=round(duration, 1),
                    sentences=len(timed), intervals=len(intervals),
                    elapsed=round(time.time() - t0, 1),
                    method="energy-alignment(silencedetect)")
    return jsonify({"ok": True, "duration": round(duration, 3),
                    "speechIntervals": intervals,
                    "sentences": timed,
                    "method": ("energy-alignment: sentences mapped onto detected "
                               "speech intervals by word count; pauses preserved. "
                               "Install Whisper for true word-level ASR timing.")})


@app.post("/api/pipeline/plan")
def pipeline_plan():
    data = request.json or {}
    script = data.get("script", "")
    timed = data.get("timed", [])
    if not script.strip() or not timed:
        return err("script and timed sentences required")
    plan = analysis.full_plan(script, timed)
    store.log_event("plan_built", segments=len(plan["segments"]),
                    subtitles=len(plan["subtitles"]),
                    overlays=len(plan["overlays"]))
    return jsonify({"ok": True, "plan": plan})


# ------------------------------------------------------------------- b-roll
@app.get("/api/broll/search")
def broll_search():
    """Two-stage search: metadata/thumbnails first (cached). provider=auto
    walks enabled providers by priority with fallback. media_type=video|image."""
    provider = request.args.get("provider", "auto")
    query = request.args.get("q", "").strip()
    orientation = request.args.get("orientation", "landscape")
    media_type = request.args.get("media_type", "video")
    if media_type not in ("video", "image"):
        media_type = "video"
    per_page = min(24, max(4, int(request.args.get("per_page", 12))))
    need_duration = float(request.args.get("need_duration", 0) or 0)
    used_ids = request.args.get("used", "")
    used_ids = [u for u in used_ids.split(",") if u] if used_ids else []
    if not query:
        return err("empty query")
    keys = [provider] if provider != "auto" else [k for _, k in _provider_chain()]
    if not keys:
        return err("No B-roll provider is enabled. Add a free API key in Settings.", 503)
    attempts = []
    for key in keys:
        if not registry.is_implemented(key):
            attempts.append({"provider": key, "result": "manual/future provider"})
            continue
        if _in_cooldown(key):
            attempts.append({"provider": key, "result": "cooling down after rate limit"})
            continue
        cfg = store.get_provider_settings().get(key, {})
        meta = registry.get_adapter(key).meta
        if media_type not in meta.media_types:
            attempts.append({"provider": key,
                             "result": f"does not serve {media_type}"})
            continue
        # cache first (stage 1 = metadata/thumbnails, never full downloads)
        payload, hit = store.cache_get(key, query, orientation, media_type)
        if hit:
            store.log_event("search_cache_hit", provider=key, q=query)
            ranked = rank_candidates(payload, query, need_duration, used_ids, media_type)
            return jsonify({"ok": True, "provider": key, "query": query,
                            "candidates": ranked, "cached": True,
                            "media_type": media_type, "attempts": attempts})
        try:
            _guard(key)
            adapter = registry.get_adapter(key, cfg.get("api_key", ""))
            t0 = time.time()
            cands = adapter.search(query, orientation=orientation,
                                   per_page=per_page, media_type=media_type)
            ms = (time.time() - t0) * 1000
            payload = [asdict(c) for c in cands]
            store.cache_put(key, query, orientation, payload, media_type)
            store.log_event("search", provider=key, q=query, results=len(payload),
                            ms=round(ms))
            if payload:
                ranked = rank_candidates(payload, query, need_duration, used_ids, media_type)
                return jsonify({"ok": True, "provider": key, "query": query,
                                "candidates": ranked, "cached": False,
                                "media_type": media_type, "attempts": attempts})
            attempts.append({"provider": key, "result": "no results"})
        except Exception as e:  # noqa: BLE001 - provider fallback, keep going
            msg = str(e)
            if "429" in msg or "rate limit" in msg.lower():
                _set_cooldown(key, 180)
            attempts.append({"provider": key, "result": f"error: {msg[:160]}"})
            store.log_event("search_failed", provider=key, q=query,
                            error=msg[:200])
            continue
    return jsonify({"ok": False, "error": "No provider returned results",
                    "attempts": attempts}), 502


@app.post("/api/broll/download")
def broll_download():
    """Stage 2: download full quality only for the chosen candidate.
    Only the required asset is downloaded (spec: never bulk-download search
    results). The file URL is resolved from the server-side search cache when
    possible so a client cannot turn this into an open fetch proxy."""
    data = request.json or {}
    cand = data.get("candidate") or {}
    provider = cand.get("provider", "")
    asset_id = str(cand.get("asset_id", ""))
    media_type = cand.get("media_type", "video")
    orientation = cand.get("orientation", "landscape")
    query = cand.get("searchQuery") or cand.get("search_query") or ""

    file_url = ""
    if provider and asset_id:
        cached = _cached_candidate(provider, asset_id, query, orientation,
                                   media_type)
        if cached and cached.get("file_url"):
            file_url = cached["file_url"]
            cand = {**cand, **{k: cached.get(k, cand.get(k))
                               for k in ("file_width", "file_height", "duration",
                                         "license_name", "attribution_required",
                                         "creator", "creator_url", "page_url",
                                         "preview_url", "title",
                                         "resolution_label")}}
    if not file_url:
        file_url = cand.get("file_url", "")
    # Host allowlist from the provider registry (anti open-proxy).
    from urllib.parse import urlparse
    host = urlparse(file_url).hostname or ""
    allowed_hosts: tuple = ()
    try:
        allowed_hosts = tuple(registry.get_adapter(provider).meta.cdn_hosts or ())
    except Exception:  # noqa: BLE001 - unknown provider -> deny
        allowed_hosts = ()
    host_ok = (file_url.startswith("https://") and allowed_hosts and
               any(host == a or host.endswith("." + a) for a in allowed_hosts))
    if not file_url or not host_ok:
        return err("file host not allowlisted for B-roll download", 400)

    is_image = media_type == "image"
    ext = ".mp4"
    if is_image:
        low = file_url.lower().split("?")[0]
        ext = ".png" if low.endswith(".png") else ".jpg"
    name = store.new_id("br") + ext
    dest = store.safe_join(store.DIRS["uploads"], name)
    t0 = time.time()
    try:
        req = urllib.request.Request(file_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=180) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f, 1 << 20)
    except Exception as e:  # noqa: BLE001
        return err(f"download failed: {str(e)[:200]}", 502)
    info = media_lib.probe(dest)
    thumb = name + ".jpg"
    if media_lib.make_thumbnail(dest, store.safe_join(store.DIRS["uploads"], thumb)):
        th = thumb
    else:
        th = None
    now = time.strftime("%Y-%m-%d")
    asset = {
        "name": name,
        "original": f"{provider}_{asset_id}{ext}",
        "kind": "image" if is_image else "video",
        "sourceType": "broll",
        "provider": provider, "assetId": asset_id,
        "pageUrl": cand.get("page_url"), "previewUrl": cand.get("preview_url"),
        "creator": cand.get("creator"), "creatorUrl": cand.get("creator_url"),
        "license": cand.get("license_name"),
        "attributionRequired": bool(cand.get("attribution_required")),
        "retrievedAt": cand.get("retrieved_at") or now,
        "searchQuery": query,
        "resolution": cand.get("resolution_label") or "",
        "mediaType": media_type,
        "width": info["width"], "height": info["height"],
        "duration": round(info["duration"], 2),
        "orientation": ("portrait" if info["height"] > info["width"] * 1.05
                        else "landscape"),
        "thumb": th, "scenes": [] if is_image else media_lib.scene_moments(dest)[:20],
        "size": os.path.getsize(dest),
    }
    store.log_event("broll_downloaded", provider=asset["provider"],
                    asset=asset["assetId"], ms=round((time.time() - t0) * 1000),
                    bytes=asset["size"])
    return jsonify({"ok": True, "asset": asset})


def _finalize_imported_asset(dest, name, provider, asset_id, media_type,
                            page_url, license_name, attribution_required,
                            creator, original_label, search_query=""):
    """Probe a downloaded file and register it as a b-roll asset dict.
    Shared by /api/broll/download and /api/broll/import-url."""
    info = media_lib.probe(dest)
    if not info or not info.get("width"):
        try:
            os.remove(dest)
        except OSError:
            pass
        return None, "the downloaded file is not a valid video/image"
    thumb = name + ".jpg"
    th = thumb if media_lib.make_thumbnail(
        dest, store.safe_join(store.DIRS["uploads"], thumb)) else None
    is_image = media_type == "image"
    now = time.strftime("%Y-%m-%d")
    asset = {
        "name": name,
        "original": original_label,
        "kind": "image" if is_image else "video",
        "sourceType": "broll",
        "provider": provider, "assetId": asset_id,
        "pageUrl": page_url, "previewUrl": None,
        "creator": creator, "creatorUrl": None,
        "license": license_name,
        "attributionRequired": bool(attribution_required),
        "retrievedAt": now,
        "searchQuery": search_query,
        "resolution": "",
        "mediaType": media_type,
        "width": info["width"], "height": info["height"],
        "duration": round(info["duration"], 2),
        "orientation": ("portrait" if info["height"] > info["width"] * 1.05
                        else "landscape"),
        "thumb": th, "scenes": [] if is_image else media_lib.scene_moments(dest)[:20],
        "size": os.path.getsize(dest),
    }
    return asset, ""


@app.post("/api/broll/import-url")
def broll_import_url():
    """Manual-provider import: the user pastes a direct file URL from a
    manual provider's site (Mixkit, Coverr, Videvo, Dareful, Freepik).

    There is deliberately no automated search here — those sites offer no
    verified public search API. The URL host must belong to the provider's
    own domain (anti open-proxy), the file is validated with ffprobe, and
    the provider's real license metadata is attached. Nothing is faked:
    if the URL is not from the provider's site, or the file is not real
    media, the import is rejected with a clear error."""
    from urllib.parse import urlparse
    data = request.json or {}
    provider = str(data.get("provider", "")).strip()
    file_url = str(data.get("url", "")).strip()
    media_type = str(data.get("media_type", "video")).strip().lower()
    try:
        meta = registry.get_meta(provider)
    except KeyError:
        return err(f"unknown provider '{provider}'", 400)
    if meta.category != "manual":
        return err("import-url is only for manual providers", 400)
    if media_type not in (meta.media_types or ["video"]):
        return err(f"{meta.name} import supports: {', '.join(meta.media_types)}", 400)
    if not file_url.startswith("https://"):
        return err("URL must start with https://", 400)
    host = (urlparse(file_url).hostname or "").lower()
    allowed = tuple(meta.cdn_hosts or ())
    if not allowed or not any(host == a or host.endswith("." + a) for a in allowed):
        return err(
            f"URL host '{host}' is not on {meta.name}'s own site "
            f"({', '.join(allowed)}). Paste a direct file link from the "
            f"{meta.name} page itself.", 400)
    low = file_url.lower().split("?")[0]
    if media_type == "image":
        ext = ".png" if low.endswith(".png") else ".jpg"
    else:
        ext = ".mp4" if low.endswith(".mp4") else (".webm" if low.endswith(".webm") else ".mp4")
    name = store.new_id("br") + ext
    dest = store.safe_join(store.DIRS["uploads"], name)
    t0 = time.time()
    # 400 MB cap: a manual import must never become an open download proxy.
    max_bytes = 400 * 1024 * 1024
    try:
        req = urllib.request.Request(file_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=180) as r:
            total = 0
            with open(dest, "wb") as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError("file larger than 400 MB — download manually instead")
                    f.write(chunk)
    except Exception as e:  # noqa: BLE001
        try:
            os.remove(dest)
        except OSError:
            pass
        return err(f"download failed: {str(e)[:200]}", 502)
    asset_id = "manual-" + name.rsplit(".", 1)[0]
    asset, aerr = _finalize_imported_asset(
        dest, name, provider, asset_id, media_type,
        page_url=meta.signup_url, license_name=meta.license_name,
        attribution_required=meta.attribution_required,
        creator=f"Manual import ({meta.name})",
        original_label=f"{provider}_manual{ext}",
        search_query="manual import")
    if asset is None:
        return err(aerr, 422)
    store.log_event("broll_imported", provider=provider, asset=asset_id,
                    ms=round((time.time() - t0) * 1000), bytes=asset["size"])
    return jsonify({"ok": True, "asset": asset})


# ---------------------------------------------------------------- settings
_META_FIELDS = ("key", "name", "needs_api_key", "signup_url", "docs_url",
                "license_name", "license_url", "attribution_required",
                "quota_notes", "verified_working", "status_note",
                "media_types", "category", "auth_type", "rate_limit",
                "commercial_use", "redistribution_notes", "icon")


@app.get("/api/settings/providers")
def settings_list():
    metas = []
    for m in registry.all_metas():
        metas.append({k: getattr(m, k) for k in _META_FIELDS})
    return jsonify({"ok": True, "providers": metas,
                    "config": store.public_provider_settings()})


@app.post("/api/settings/providers/<key>")
def settings_save(key):
    if not registry.is_implemented(key):
        return err("provider not available in this build", 404)
    data = request.json or {}
    cfg = store.get_provider_settings()
    cur = cfg.get(key, {})
    if "api_key" in data and data["api_key"]:
        cur["api_key"] = data["api_key"]
    if "enabled" in data:
        cur["enabled"] = bool(data["enabled"])
    if "priority" in data:
        cur["priority"] = int(data["priority"])
    cfg[key] = cur
    store.save_provider_settings(cfg)
    store.log_event("provider_saved", provider=key,
                    enabled=cur.get("enabled", True))
    return jsonify({"ok": True, "config": store.public_provider_settings()})


@app.post("/api/settings/providers/priority")
def settings_priority():
    """Bulk reorder: {order: [key1, key2, ...]} -> priorities 10, 20, 30..."""
    data = request.json or {}
    order = data.get("order") or []
    cfg = store.get_provider_settings()
    for i, key in enumerate(order):
        if registry.is_implemented(key):
            cur = cfg.get(key, {})
            cur["priority"] = (i + 1) * 10
            cfg[key] = cur
    store.save_provider_settings(cfg)
    store.log_event("provider_priority", order=order)
    return jsonify({"ok": True, "config": store.public_provider_settings()})


@app.post("/api/settings/providers/<key>/disconnect")
def settings_disconnect(key):
    cfg = store.get_provider_settings()
    if key in cfg:
        cfg[key].pop("api_key", None)
        cfg[key]["enabled"] = False
        store.save_provider_settings(cfg)
    return jsonify({"ok": True, "config": store.public_provider_settings()})


@app.post("/api/settings/providers/<key>/test")
def settings_test(key):
    """Real connection test. Accepts an optional unsaved api_key in the body
    so the user can TEST before SAVE. Never stores the ephemeral key."""
    if not registry.is_implemented(key):
        return err("provider not available in this build", 404)
    data = request.json or {}
    cfg = store.get_provider_settings().get(key, {})
    api_key = data.get("api_key") or cfg.get("api_key", "")
    adapter = registry.get_adapter(key, api_key)
    ok, msg = adapter.test_connection()
    store.log_event("provider_test", provider=key, ok=ok, msg=msg[:120])
    return jsonify({"ok": ok, "message": msg,
                    "connected": ok, "tested_with_saved_key": not data.get("api_key")})


@app.post("/api/settings/providers/<key>/test-search")
def settings_test_search(key):
    """Real search test: runs an actual provider search and returns results."""
    if not registry.is_implemented(key):
        return err("provider not available in this build", 404)
    data = request.json or {}
    q = (data.get("q") or "business meeting").strip()[:120]
    media_type = data.get("media_type", "video")
    if media_type not in ("video", "image"):
        media_type = "video"
    cfg = store.get_provider_settings().get(key, {})
    meta = registry.get_adapter(key).meta
    if media_type not in meta.media_types:
        return err(f"{meta.name} does not serve {media_type}", 400)
    try:
        _guard(key)
        adapter = registry.get_adapter(key, cfg.get("api_key", ""))
        cands = adapter.search(q, per_page=6, media_type=media_type)
        results = []
        for c in cands:
            d = asdict(c)
            d.pop("raw", None)
            results.append(d)
        store.log_event("provider_test_search", provider=key, q=q,
                        results=len(results))
        return jsonify({"ok": True, "provider": key, "query": q,
                        "media_type": media_type, "results": results,
                        "count": len(results)})
    except Exception as e:  # noqa: BLE001 - surfaced honestly
        from .providers.base import classify_error
        return jsonify({"ok": False, "error": classify_error(str(e))}), 502


# ---------------------------------------------------------------- projects
@app.get("/api/projects")
def projects_list():
    return jsonify({"ok": True, "projects": store.list_projects()})


@app.post("/api/projects")
def projects_create():
    data = request.json or {}
    pid = data.get("id") or store.new_id("proj")
    data["id"] = pid
    data["updatedAt"] = time.time()
    store.save_project(pid, data)
    store.log_event("project_saved", id=pid, name=data.get("name"))
    return jsonify({"ok": True, "id": pid})


@app.get("/api/projects/<pid>")
def projects_get(pid):
    data = store.load_project(pid)
    if not data:
        return err("not found", 404)
    return jsonify({"ok": True, "project": data})


@app.delete("/api/projects/<pid>")
def projects_delete(pid):
    return jsonify({"ok": True, "deleted": store.delete_project(pid)})


# ------------------------------------------------------------------ export
@app.post("/api/export")
def export_start():
    data = request.json or {}
    timeline = data.get("timeline")
    settings = data.get("settings", {})
    if not timeline or not timeline.get("clips"):
        return err("empty timeline")
    job_id = export_mod.start_job(timeline, settings)
    return jsonify({"ok": True, "job": job_id})


@app.get("/api/export/<job_id>")
def export_status(job_id):
    job = export_mod.JOBS.get(job_id)
    if not job:
        return err("unknown job", 404)
    return jsonify({"ok": True, "status": job.get("status"),
                    "progress": round(job.get("progress", 0), 3),
                    "error": job.get("error"),
                    "elapsed": job.get("elapsed"),
                    "size": job.get("size")})


@app.get("/api/export/<job_id>/download")
def export_download(job_id):
    job = export_mod.JOBS.get(job_id)
    if not job or job.get("status") != "done":
        return err("not ready", 404)
    return send_file(job["output"], as_attachment=True,
                     download_name=f"broll-editor-{job_id}.mp4")


# ----------------------------------------------------------------- metrics
@app.get("/api/metrics")
def metrics():
    return jsonify({"ok": True, "events": store.read_metrics(800)})


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "ffmpeg": shutil.which("ffmpeg") is not None})


director_routes.register_director(app)
editing_routes.register_editing(app)
audiofx_routes.register_audiofx(app)
register_metrics(app)


def main():
    port = int(os.environ.get("PORT", 8099))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"B-Roll Auto Editor on http://{host}:{port}")
    app.run(host=host, port=port, threaded=True)


if __name__ == "__main__":
    main()
