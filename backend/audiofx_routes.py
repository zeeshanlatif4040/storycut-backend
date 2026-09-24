"""AudioFX HTTP routes. Registered via register_audiofx(app) — see WIRING.txt.

Conventions mirror backend/app.py's upload handling:
- audio referenced by upload id: {"name": "<upload file name>"}
- path resolved with store.safe_join(store.DIRS["uploads"], basename)
- 404 when the file is missing; JSON error bodies otherwise
"""
from __future__ import annotations
import os
import time

from flask import request, jsonify

from . import audiofx, media as media_lib, store
from .metrics import timed, bump


def _err(msg, code=400):
    return jsonify({"ok": False, "error": msg}), code


def _resolve_upload(name: str) -> str | None:
    name = os.path.basename(name or "")
    if not name:
        return None
    try:
        path = store.safe_join(store.DIRS["uploads"], name)
    except ValueError:
        return None
    return path if os.path.exists(path) else None


def register_audiofx(app) -> None:
    @app.post("/api/audiofx/analyze")
    def audiofx_analyze():
        data = request.json or {}
        path = _resolve_upload(data.get("name", ""))
        if not path:
            return _err("audio file not found", 404)
        with timed("audiofx_analyze"):
            try:
                result = audiofx.analyze_audio(path)
            except Exception as e:  # noqa: BLE001 - surfaced honestly
                return _err(f"analysis failed: {str(e)[:200]}", 500)
        hints = {}
        try:
            with timed("audiofx_rhythm"):
                hints = audiofx.rhythm_hints(path)
        except Exception:  # noqa: BLE001 - hints are best-effort
            hints = {"onsets": [], "method": "unavailable"}
        bump("audiofx_analyze_ok")
        store.log_event("audiofx_analyzed", name=os.path.basename(path),
                        duration=result.get("duration"),
                        peak_db=result.get("peak_db"),
                        clipping=result.get("clipping"))
        return jsonify({"ok": True, "analysis": result,
                        "rhythm_hints": hints})

    @app.post("/api/audiofx/enhance")
    def audiofx_enhance():
        data = request.json or {}
        path = _resolve_upload(data.get("name", ""))
        if not path:
            return _err("audio file not found", 404)
        opts = {
            "normalize": bool(data.get("normalize", True)),
            "denoise": bool(data.get("denoise", False)),
            "dynamic": bool(data.get("dynamic", False)),
            "target_lufs": data.get("target_lufs", -16.0),
        }
        out_name = store.new_id("afx") + ".wav"
        out_path = store.safe_join(store.DIRS["uploads"], out_name)
        t0 = time.time()
        try:
            with timed("audiofx_enhance"):
                report = audiofx.enhance_audio(path, out_path, opts)
        except ValueError as e:
            return _err(str(e), 400)
        except Exception as e:  # noqa: BLE001 - surfaced honestly
            return _err(f"enhancement failed: {str(e)[:200]}", 500)
        info = media_lib.probe(out_path)
        asset = {
            "name": out_name,
            "original": f"enhanced_{os.path.basename(path)}",
            "kind": "audio",
            "sourceType": "audiofx",
            "ext": ".wav",
            "size": os.path.getsize(out_path),
            "duration": round(info["duration"], 2),
            "enhancement": {k: v for k, v in report.items()
                            if k != "out_path"},
        }
        bump("audiofx_enhance_ok")
        store.log_event("audiofx_enhanced",
                        src=os.path.basename(path), out=out_name,
                        filters=",".join(
                            f.split("=")[0] for f in report["filter_chain"]),
                        ms=round((time.time() - t0) * 1000))
        return jsonify({"ok": True, "asset": asset, "report": report})
