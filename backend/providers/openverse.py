"""Openverse image provider adapter (https://api.openverse.org/).

No API key needed for anonymous access (documented anonymous rate limits
apply; OAuth raises them). Images only — Openverse has no video collection.
Only commercially-usable licenses are requested (license_type=commercial),
and every result carries its own license + attribution requirement, because
Openverse aggregates CC-licensed works with varying terms.
Docs: https://api.openverse.org/ / https://wordpress.org/openverse/
"""
from __future__ import annotations
import time
import urllib.request
import urllib.parse
import urllib.error
import json
from .base import (BaseProvider, ProviderMeta, Candidate, orientation_of,
                   resolution_label)

META = ProviderMeta(
    key="openverse",
    name="Openverse",
    needs_api_key=False,
    signup_url="https://api.openverse.org/",
    docs_url="https://api.openverse.org/",
    license_name="Varies per work (CC licenses; commercial subset only)",
    license_url="https://wordpress.org/openverse/",
    attribution_required=True,
    quota_notes=("Anonymous access is allowed but heavily rate-limited per the "
                 "official throttling docs; free OAuth registration raises "
                 "limits. This app queues requests and backs off on HTTP 429."),
    verified_working=True,  # verified with a real API call on 2026-09-24
    status_note="Live and verified — no API key needed. Only licenses that "
                "allow commercial use and derivatives are requested; "
                "attribution is required for CC-licensed works.",
    media_types=["image"],
    category="api",
    auth_type="none",
    rate_limit="Documented anonymous limits apply; see Openverse API docs",
    commercial_use="Yes — this adapter only requests license_type=commercial, "
                   "but always verify the license shown on each result.",
    redistribution_notes=("Reuse is governed by each work's CC license; "
                          "attribution is required except for CC0/Public Domain."),
    icon="🔎",
    cdn_hosts=(),  # direct URLs point at original source hosts; downloads are
                   # verified against the server-side search cache instead.
)

_API = "https://api.openverse.org/v1/images/"
_UA = "ZeeshanAIWorkflow/1.0 (educational video tool)"

_LICENSE_NAMES = {
    "by": "CC BY", "by-sa": "CC BY-SA", "by-nd": "CC BY-ND",
    "by-nc": "CC BY-NC", "by-nc-sa": "CC BY-NC-SA", "by-nc-nd": "CC BY-NC-ND",
    "cc0": "CC0", "pdm": "Public Domain Mark",
}
_NO_ATTR = {"cc0", "pdm"}


class OpenverseProvider(BaseProvider):
    meta = META

    def _get(self, params: dict) -> dict:
        params = dict(params)
        full = _API + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(full, headers={"User-Agent": _UA})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "ignore")[:200]
            if e.code == 429:
                self.cooldown(120)
                raise RuntimeError(f"Openverse rate limit hit (HTTP 429). {body}")
            raise RuntimeError(f"Openverse HTTP {e.code}: {body}")
        finally:
            self.note_call((time.time() - t0) * 1000)
        return data

    def search(self, query: str, orientation: str = "landscape",
               per_page: int = 12, page: int = 1,
               media_type: str = "video") -> list[Candidate]:
        if media_type == "video":
            raise RuntimeError("Openverse has no video collection — images only.")
        params = {
            "q": query,
            "page_size": str(max(1, min(50, per_page))),
            "page": str(page),
            # Only licenses that allow commercial use AND derivatives
            # (an editor crops/pans/transforms images, so ND is excluded).
            "license": "by,by-sa,cc0,pdm",
            "filter_dead": "true",
        }
        data = self._get(params)
        out: list[Candidate] = []
        for r in data.get("results", []) or []:
            file_url = r.get("url") or ""
            if not file_url.startswith("https://"):
                continue
            lic = (r.get("license") or "").lower()
            lic_ver = r.get("license_version") or ""
            license_name = _LICENSE_NAMES.get(lic, lic.upper() or "See source page")
            if lic_ver and lic not in _NO_ATTR:
                license_name += f" {lic_ver}"
            w, h = r.get("width", 0) or 0, r.get("height", 0) or 0
            # Skip non-commercial / no-derivative leftovers defensively.
            if lic.startswith("by-nc") or lic == "by-nd":
                continue
            out.append(Candidate(
                provider="openverse", asset_id=str(r.get("id", "")),
                title=(r.get("title") or query)[:120],
                page_url=r.get("foreign_landing_url") or "",
                preview_url=r.get("thumbnail") or "",
                file_url=file_url, file_width=w, file_height=h,
                duration=0.0, orientation=orientation_of(w or 16, h or 9),
                creator=r.get("creator") or "",
                creator_url=r.get("creator_url") or "",
                license_name=license_name,
                attribution_required=lic not in _NO_ATTR,
                media_type="image",
                retrieved_at=time.strftime("%Y-%m-%d"), search_query=query,
                resolution_label=resolution_label(w, h) if h else "source",
                raw={"license_url": r.get("license_url", "")},
            ))
        if orientation in ("landscape", "portrait"):
            out = [c for c in out if c.orientation == orientation] or out
        return out
