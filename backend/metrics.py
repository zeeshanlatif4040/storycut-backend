"""In-memory performance counters for stage timings.

NOTE: this module is intentionally standalone. The app already exposes
GET /api/metrics (disk-backed event log in backend/store.py). To avoid
colliding with that route — and because backend/app.py must not be edited —
this module registers GET /api/metrics/stages for the timings recorded
here. See WIRING.txt for how the parent agent should wire it in.

Honesty note: provider-search counters are NOT auto-wired into
broll_search() in app.py (that file is frozen). Stages recorded here are
the ones added by audiofx (and anything else that calls record_stage).
Counters for search latency / cache hits on the *frontend* dashboard are
computed from the real /api/metrics event log (search, search_cache_hit,
search_failed events), never fabricated.
"""
from __future__ import annotations
import threading
import time

_lock = threading.Lock()
# name -> {"count": int, "total": float, "min": float, "max": float, "last": float}
_stages: dict[str, dict] = {}
# free-form counters, e.g. {"audiofx_enhance_ok": 3}
_counters: dict[str, int] = {}


def record_stage(name: str, seconds: float) -> None:
    """Record how long a named stage took (seconds, wall clock)."""
    seconds = max(0.0, float(seconds))
    with _lock:
        s = _stages.get(name)
        if s is None:
            s = _stages[name] = {"count": 0, "total": 0.0,
                                 "min": seconds, "max": seconds, "last": 0.0}
        s["count"] += 1
        s["total"] += seconds
        s["min"] = min(s["min"], seconds)
        s["max"] = max(s["max"], seconds)
        s["last"] = seconds


def bump(counter: str, amount: int = 1) -> None:
    with _lock:
        _counters[counter] = _counters.get(counter, 0) + amount


class timed:
    """Context manager: with timed("audiofx_analyze"): ..."""

    def __init__(self, name: str):
        self.name = name

    def __enter__(self):
        self._t0 = time.time()
        return self

    def __exit__(self, exc_type, exc, tb):
        record_stage(self.name, time.time() - self._t0)
        return False


def snapshot() -> dict:
    """JSON-serializable summary of everything recorded so far."""
    with _lock:
        stages = {}
        for name, s in _stages.items():
            n = s["count"] or 1
            stages[name] = {
                "count": s["count"],
                "avg_s": round(s["total"] / n, 3),
                "min_s": round(s["min"], 3),
                "max_s": round(s["max"], 3),
                "last_s": round(s["last"], 3),
                "total_s": round(s["total"], 3),
            }
        return {
            "stages": stages,
            "counters": dict(_counters),
            "note": ("Timings recorded by stages that call record_stage() "
                     "(currently audiofx). Provider search latency/cache stats "
                     "come from the /api/metrics event log, not from here."),
        }


def register_metrics(app) -> None:
    """Attach the stages endpoint. Call once from the app factory / main.

    Route is /api/metrics/stages (NOT /api/metrics — that route already
    exists in app.py and app.py is frozen).
    """

    @app.get("/api/metrics/stages")
    def metrics_stages():
        from flask import jsonify
        return jsonify({"ok": True, **snapshot()})
