"""HTTP API for editing controls. Registered via register_editing(app);
app.py itself is never modified (see WIRING.txt).

All endpoints return JSON and never crash: bad input -> {"ok": False,
"error": ...} with a 4xx status.
"""
from __future__ import annotations
from flask import request, jsonify

from . import editing, store

# Real filesystem base for the "missing media" QC check: asset names stored
# on clips resolve to files under the uploads directory.
_MEDIA_BASE = store.DIRS["uploads"]


def _err(msg, code=400):
    return jsonify({"ok": False, "error": msg}), code


def register_editing(app):
    @app.post("/api/editing/lock")
    def editing_lock():
        data = request.get_json(silent=True) or {}
        pid = str(data.get("project_id") or "default")
        try:
            idx = int(data.get("scene_idx"))
        except (TypeError, ValueError):
            return _err("scene_idx must be an integer")
        locked = data.get("locked")
        if not isinstance(locked, bool):
            return _err("locked must be true/false")
        try:
            locks = editing.lock_scene(pid, idx, locked)
        except (TypeError, ValueError) as e:
            return _err(str(e))
        return jsonify({"ok": True, "project_id": pid,
                        "locks": {str(k): v for k, v in locks.items()},
                        "scene_idx": idx, "locked": locked})

    @app.get("/api/editing/locks")
    def editing_locks():
        pid = str(request.args.get("project_id") or "default")
        locks = editing.get_locks(pid)
        return jsonify({"ok": True, "project_id": pid,
                        "locks": {str(k): v for k, v in locks.items()}})

    @app.get("/api/editing/profiles")
    def editing_profiles():
        return jsonify({"ok": True, "profiles": editing.STYLE_PROFILES,
                        "info": editing.PROFILE_INFO})

    @app.get("/api/editing/modes")
    def editing_modes():
        return jsonify({
            "ok": True,
            "source_modes": editing.SOURCE_MODES,
            "source_mode_info": editing.SOURCE_MODE_INFO,
            "creative_modes": editing.CREATIVE_MODES,
            "creative_mode_info": editing.CREATIVE_MODE_INFO,
        })

    def _project_from_body():
        data = request.get_json(silent=True) or {}
        project = data.get("project")
        if not isinstance(project, dict):
            return None, _err("body must contain a 'project' object")
        return project, None

    @app.post("/api/editing/qc")
    def editing_qc():
        project, e = _project_from_body()
        if e:
            return e
        try:
            findings = editing.run_qc(project, media_base=_MEDIA_BASE)
        except Exception as ex:  # never crash the request
            return _err(f"QC failed: {ex}", 500)
        editing.sync_locks_from_project(project)
        return jsonify({"ok": True, "findings": findings,
                        "counts": {
                            "error": sum(1 for f in findings
                                         if f["severity"] == "error"),
                            "warning": sum(1 for f in findings
                                           if f["severity"] == "warning"),
                            "info": sum(1 for f in findings
                                        if f["severity"] == "info"),
                        }})

    @app.post("/api/editing/fix")
    def editing_fix():
        data = request.get_json(silent=True) or {}
        project = data.get("project")
        finding_id = data.get("finding_id")
        if not isinstance(project, dict):
            return _err("body must contain a 'project' object")
        if not finding_id:
            return _err("finding_id is required")
        try:
            result = editing.auto_fix(project, str(finding_id),
                                  media_base=_MEDIA_BASE)
            findings = editing.run_qc(project, media_base=_MEDIA_BASE) if result.get("ok") else []
        except Exception as ex:
            return _err(f"auto-fix failed: {ex}", 500)
        out = {"ok": bool(result.get("ok")), "message": result.get("message"),
               "project": project, "findings": findings}
        return jsonify(out), (200 if result.get("ok") else 422)

    @app.post("/api/editing/apply")
    def editing_apply():
        data = request.get_json(silent=True) or {}
        project = data.get("project")
        if not isinstance(project, dict):
            return _err("body must contain a 'project' object")
        try:
            changes = editing.apply_editing_settings(
                project, data.get("creative_mode", "BALANCED"),
                data.get("profile", "DOCUMENTARY"))
        except ValueError as e:
            return _err(str(e))
        except Exception as ex:
            return _err(f"apply failed: {ex}", 500)
        return jsonify({"ok": True, "project": project, "changes": changes})

    @app.post("/api/editing/report")
    def editing_report():
        project, e = _project_from_body()
        if e:
            return e
        try:
            report = editing.build_report(project)
        except ValueError as ex:
            return _err(str(ex))
        except Exception as ex:
            return _err(f"report failed: {ex}", 500)
        return jsonify({"ok": True, "report": report})
