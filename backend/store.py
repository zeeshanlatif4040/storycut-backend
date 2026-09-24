"""Server-side storage: provider settings (secrets stay server-side),
search cache, projects, and a metrics log. All JSON on disk."""
from __future__ import annotations
import json
import os
import time
import hashlib
import uuid

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "storage")
DIRS = {k: os.path.join(ROOT, k) for k in
        ("uploads", "projects", "cache", "exports", "settings", "metrics")}
for d in DIRS.values():
    os.makedirs(d, exist_ok=True)

SETTINGS_FILE = os.path.join(DIRS["settings"], "providers.json")
METRICS_FILE = os.path.join(DIRS["metrics"], "events.jsonl")
CACHE_TTL = 24 * 3600


def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


# ------------------------------------------------------------- settings
def get_provider_settings() -> dict:
    """{provider_key: {api_key, enabled, priority}} — raw, server-side only."""
    return _read_json(SETTINGS_FILE, {})


def save_provider_settings(cfg: dict):
    _write_json(SETTINGS_FILE, cfg)


def public_provider_settings() -> dict:
    """Masked version safe to send to the client."""
    cfg = get_provider_settings()
    out = {}
    for k, v in cfg.items():
        key = v.get("api_key", "")
        out[k] = {
            "enabled": bool(v.get("enabled", True)),
            "priority": int(v.get("priority", 50)),
            "has_key": bool(key),
            "masked": ("••••••••" + key[-4:]) if len(key) > 4 else ("••••" if key else ""),
        }
    return out


# ----------------------------------------------------------------- cache
def _cache_path(provider: str, query: str, orientation: str,
                media_type: str = "video") -> str:
    h = hashlib.sha256(
        f"{provider}|{query.lower().strip()}|{orientation}|{media_type}".encode()
    ).hexdigest()
    d = os.path.join(DIRS["cache"], provider)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, h + ".json")


def cache_get(provider: str, query: str, orientation: str,
              media_type: str = "video"):
    p = _cache_path(provider, query, orientation, media_type)
    data = _read_json(p, None)
    if not data:
        return None, False
    if time.time() - data.get("ts", 0) > CACHE_TTL:
        return None, False
    return data.get("payload"), True


def cache_put(provider: str, query: str, orientation: str, payload,
              media_type: str = "video"):
    p = _cache_path(provider, query, orientation, media_type)
    _write_json(p, {"ts": time.time(), "payload": payload})


# --------------------------------------------------------------- projects
def project_path(pid: str) -> str:
    safe = "".join(c for c in pid if c.isalnum() or c in "-_")
    return os.path.join(DIRS["projects"], safe + ".json")


def save_project(pid: str, obj: dict):
    _write_json(project_path(pid), obj)


def load_project(pid: str):
    return _read_json(project_path(pid), None)


def list_projects() -> list[dict]:
    out = []
    for fn in sorted(os.listdir(DIRS["projects"]), reverse=True):
        if not fn.endswith(".json"):
            continue
        data = _read_json(os.path.join(DIRS["projects"], fn), None)
        if data:
            out.append({k: data.get(k) for k in
                        ("id", "name", "updatedAt", "format", "duration",
                         "clipCount", "mode")})
    return out


def delete_project(pid: str) -> bool:
    p = project_path(pid)
    if os.path.exists(p):
        os.remove(p)
        return True
    return False


def new_id(prefix="p") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


# ---------------------------------------------------------------- metrics
def log_event(event: str, **fields):
    rec = {"ts": time.time(), "event": event, **fields}
    try:
        with open(METRICS_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass


def read_metrics(limit: int = 500) -> list[dict]:
    if not os.path.exists(METRICS_FILE):
        return []
    with open(METRICS_FILE, "r", encoding="utf-8") as f:
        lines = f.readlines()[-limit:]
    out = []
    for ln in lines:
        try:
            out.append(json.loads(ln))
        except ValueError:
            pass
    return out


# ------------------------------------------------------- safe path guard
def safe_join(base: str, name: str) -> str:
    """Join and ensure the result stays inside base (no traversal)."""
    base = os.path.abspath(base)
    target = os.path.abspath(os.path.join(base, name))
    if not (target == base or target.startswith(base + os.sep)):
        raise ValueError("unsafe path")
    return target
