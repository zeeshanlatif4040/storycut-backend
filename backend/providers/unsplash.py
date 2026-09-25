"""Unsplash image provider adapter (https://unsplash.com/documentation).

Free API key required (user supplies it in Settings; stored server-side).
Unsplash API guidelines REQUIRE attribution (photographer + Unsplash).
Only documented endpoints are used. Images only.
"""
from __future__ import annotations
import time
from .http import api_get_json, ProviderHttpError
from .base import (BaseProvider, ProviderMeta, Candidate, orientation_of,
                   resolution_label)

META = ProviderMeta(
    key="unsplash",
    name="Unsplash",
    needs_api_key=True,
    signup_url="https://unsplash.com/developers",
    docs_url="https://unsplash.com/documentation",
    license_name="Unsplash License",
    license_url="https://unsplash.com/license",
    attribution_required=True,
    quota_notes=("Demo apps: 50 requests/hour (documented). Production needs "
                 "Unsplash approval with higher limits. This app queues "
                 "requests and backs off on HTTP 429/403 rate responses."),
    verified_working=False,
    status_note="Requires a free Unsplash API key. Attribution is required "
                "by the Unsplash API guidelines.",
    media_types=["image"],
    category="api",
    auth_type="api_key",
    rate_limit="50 requests/hour on demo tier (documented)",
    commercial_use="Yes — the Unsplash License permits commercial use.",
    redistribution_notes=("Do not sell unaltered copies or offer Unsplash "
                          "photos as stock. Attribution required by the API "
                          "guidelines when using the API."),
    icon="📸",
    cdn_hosts=("unsplash.com",),
)

_API = "https://api.unsplash.com/search/photos"


class UnsplashProvider(BaseProvider):
    meta = META

    def _get(self, params: dict) -> dict:
        if not self.api_key:
            raise RuntimeError("Unsplash API key not configured")
        t0 = time.time()
        try:
            # Browser fingerprint (see providers/http.py): Cloudflare blocks
            # datacenter IPs presenting Python's TLS fingerprint with
            # HTTP 403 + "error code: 1010" before the key is ever checked.
            return api_get_json(
                _API, params,
                headers={"Authorization": f"Client-ID {self.api_key}",
                         "Accept-Version": "v1"})
        except ProviderHttpError as e:
            body = e.body[:200]
            if e.code == 429 or (e.code == 403 and "rate" in body.lower()):
                self.cooldown(120)
                raise RuntimeError(f"Unsplash rate limit hit (HTTP {e.code}). {body}")
            if e.code in (401, 403):
                raise RuntimeError(f"Unsplash auth failed (HTTP {e.code}): check API key. {body}")
            raise RuntimeError(f"Unsplash HTTP {e.code}: {body}")
        finally:
            self.note_call((time.time() - t0) * 1000)
        return data

    def search(self, query: str, orientation: str = "landscape",
               per_page: int = 12, page: int = 1,
               media_type: str = "video", target_h: int = 1080) -> list[Candidate]:
        if media_type == "video":
            raise RuntimeError("Unsplash serves images only — no video API.")
        orient = {"landscape": "landscape", "portrait": "portrait",
                  "square": "squarish"}.get(orientation, "landscape")
        params = {"query": query, "per_page": max(1, min(30, per_page)),
                  "page": page, "orientation": orient}
        data = self._get(params)
        out: list[Candidate] = []
        for p in data.get("results", []) or []:
            urls = p.get("urls", {}) or {}
            raw = urls.get("raw")
            if not raw:
                continue
            ow, oh = p.get("width", 0) or 0, p.get("height", 0) or 0
            # Unsplash documents imgix resizing params: request 1920-wide.
            if ow >= 1920 or ow == 0:
                file_url = raw + ("&" if "?" in raw else "?") + "w=1920&auto=format&fit=max"
                w, h = (1920, round(oh * 1920 / ow)) if ow else (0, 0)
            else:
                file_url, w, h = raw, ow, oh
            user = p.get("user", {}) or {}
            ulinks = user.get("links", {}) or {}
            out.append(Candidate(
                provider="unsplash", asset_id=str(p.get("id")),
                title=(p.get("alt_description") or p.get("description") or query)[:120],
                page_url=(p.get("links", {}) or {}).get("html", ""),
                preview_url=urls.get("small") or urls.get("thumb") or "",
                file_url=file_url, file_width=w, file_height=h,
                duration=0.0, orientation=orientation_of(w or 16, h or 9),
                creator=user.get("name", ""),
                creator_url=ulinks.get("html", ""),
                license_name="Unsplash License", attribution_required=True,
                media_type="image",
                retrieved_at=time.strftime("%Y-%m-%d"), search_query=query,
                resolution_label=resolution_label(w, h) if h else "",
                raw={},
            ))
        return out
