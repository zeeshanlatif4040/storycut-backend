"""HTTP routes for the rule-based Creative Director.

Registered from app.py via register_director(app) — see WIRING.txt.
Nothing here touches the existing routes.
"""
from __future__ import annotations

from flask import request, jsonify

from . import director


def _err(msg, code=400):
    return jsonify({"ok": False, "error": msg}), code


def register_director(app):
    @app.post("/api/director/analyze")
    def director_analyze():
        """Analyze a script into a story map (hook / body units / CTA).

        Body: {"script": str, "sentences": [{"text","start","end"}, ...]}
        `sentences` is optional; when omitted, unit durations are 0 and the
        response says timing is estimated.
        """
        data = request.get_json(silent=True) or {}
        script = data.get("script", "")
        sentences = data.get("sentences", [])
        if not isinstance(script, str) or not script.strip():
            return _err("empty script")
        if len(script) > 200000:
            return _err("script too long (200k chars max)")
        if not isinstance(sentences, list):
            return _err("sentences must be a list")
        for s in sentences:
            if not isinstance(s, dict) or "text" not in s:
                return _err("each sentence must be an object with 'text'")
        try:
            story = director.build_story_map(script, sentences)
        except Exception as exc:  # never crash the request
            return _err(f"director analysis failed: {exc}", 500)
        return jsonify({"ok": True, "storyMap": story,
                        "method": director.METHOD})
