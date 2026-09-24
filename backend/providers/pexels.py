"""Pexels video+image provider adapter (https://www.pexels.com/api/).

Free API key required (user supplies it in Settings; stored server-side).
Only documented endpoints and documented limits are used.
"""
from __future__ import annotations
import time
from .base import (BaseProvider, ProviderMeta, Candidate, orientation_of,
                   pick_1080p, resolution_label)
from .http import api_get_json, ProviderHttpError

META = ProviderMeta(
    key="pexels",
    name="Pexels",
    needs_api_key=True,
    signup_url="https://www.pexels.com/api/",
    docs_url="https://www.pexels.com/api/documentation/",
    license_name="Pexels License",
    license_url="https://www.pexels.com/license/",
    attribution_required=False,
    quota_notes=("Free tier: 200 requests/hour, 20,000 requests/month "
                 "(documented; X-Ratelimit headers on responses). Higher "
                 "limits available free on request. This app queues requests "
                 "and backs off on HTTP 429."),
    verified_working=False,
    status_note=("Requires a free Pexels API key. Pexels API guidelines ask "
                 "for a 'Photos provided by Pexels' credit link wherever API "
                 "results are used."),
    media_types=["video", "image"],
    category="api",
    auth_type="api_key",
    rate_limit="200 requests/hour, 20,000 requests/month (documented)",
    commercial_use="Yes — the Pexels License permits commercial use.",
    redistribution_notes=("Do not sell unaltered copies or redistribute the "
                          "Pexels library as-is. See the Pexels License."),
    icon="🎬",
    cdn_hosts=("pexels.com",),
)

_VIDEO_API = "https://api.pexels.com/videos/search"
_IMAGE_API = "https://api.pexels.com/v1/search"


class PexelsProvider(BaseProvider):
    meta = META

    def _get(self, url: str, params: dict) -> dict:
        if not self.api_key:
            raise RuntimeError("Pexels API key not configured")
        t0 = time.time()
        try:
            # Browser fingerprint (see providers/http.py): Cloudflare blocks
            # datacenter IPs presenting Python's TLS fingerprint with
            # HTTP 403 + "error code: 1010" before the key is ever checked.
            return api_get_json(url, params,
                                headers={"Authorization": self.api_key})
        except ProviderHttpError as e:
            body = e.body[:200]
            if e.code == 429:
                self.cooldown(60)
                raise RuntimeError(f"Pexels rate limit hit (HTTP 429). {body}")
            if e.code in (401, 403):
                raise RuntimeError(f"Pexels auth failed (HTTP {e.code}): check API key. {body}")
            raise RuntimeError(f"Pexels HTTP {e.code}: {body}")
        finally:
            self.note_call((time.time() - t0) * 1000)

    # ------------------------------------------------------------- search
    def search(self, query: str, orientation: str = "landscape",
               per_page: int = 12, page: int = 1,
               media_type: str = "video") -> list[Candidate]:
        if media_type == "image":
            return self._search_images(query, orientation, per_page, page)
        return self._search_videos(query, orientation, per_page, page)

    def _search_videos(self, query, orientation, per_page, page):
        orient = {"landscape": "landscape", "portrait": "portrait"}.get(orientation, "")
        params = {"query": query, "per_page": max(1, min(80, per_page)), "page": page}
        if orient:
            params["orientation"] = orient
        data = self._get(_VIDEO_API, params)
        out: list[Candidate] = []
        for v in data.get("videos", []):
            variants = []
            for f in v.get("video_files", []) or []:
                if f.get("link") and f.get("file_type") == "video/mp4":
                    variants.append((f.get("width", 0) or 0,
                                     f.get("height", 0) or 0, f["link"]))
            if not variants:  # fall back to any linked file
                for f in v.get("video_files", []) or []:
                    if f.get("link"):
                        variants.append((f.get("width", 0) or 0,
                                         f.get("height", 0) or 0, f["link"]))
            pick = pick_1080p(variants)
            if not pick:
                continue
            w, h, link = pick
            user = v.get("user", {}) or {}
            out.append(Candidate(
                provider="pexels", asset_id=str(v.get("id")),
                title=((v.get("url") or "").rstrip("/").split("/")[-1].replace("-", " ") or query),
                page_url=v.get("url", ""),
                preview_url=(v.get("image") or ""),
                file_url=link, file_width=w, file_height=h,
                duration=float(v.get("duration", 0) or 0),
                orientation=orientation_of(w, h),
                creator=user.get("name", ""), creator_url=user.get("url", ""),
                license_name="Pexels License", attribution_required=False,
                media_type="video",
                retrieved_at=time.strftime("%Y-%m-%d"), search_query=query,
                resolution_label=resolution_label(w, h),
                raw={"tags": []},
            ))
        return out

    def _search_images(self, query, orientation, per_page, page):
        orient = {"landscape": "landscape", "portrait": "portrait",
                  "square": "square"}.get(orientation, "")
        params = {"query": query, "per_page": max(1, min(80, per_page)), "page": page}
        if orient:
            params["orientation"] = orient
        data = self._get(_IMAGE_API, params)
        out: list[Candidate] = []
        for p in data.get("photos", []) or []:
            src = p.get("src", {}) or {}
            base = src.get("original") or src.get("large2x") or src.get("large")
            if not base:
                continue
            ow, oh = p.get("width", 0) or 0, p.get("height", 0) or 0
            # Documented Pexels image-CDN parameters: request a 1920-wide
            # rendition (keeps aspect ratio) instead of the full original.
            if ow >= 1920 or ow == 0:
                file_url = base + ("&" if "?" in base else "?") + \
                    "auto=compress&cs=tinysrgb&w=1920"
                w, h = (1920, round(oh * 1920 / ow)) if ow else (0, 0)
            else:
                file_url, w, h = base, ow, oh
            label = resolution_label(w, h) if h else ""
            out.append(Candidate(
                provider="pexels", asset_id=str(p.get("id")),
                title=(p.get("alt") or query)[:120],
                page_url=p.get("url", ""),
                preview_url=src.get("medium") or src.get("small") or "",
                file_url=file_url, file_width=w, file_height=h,
                duration=0.0, orientation=orientation_of(w or 16, h or 9),
                creator=(p.get("photographer") or ""),
                creator_url=(p.get("photographer_url") or ""),
                license_name="Pexels License", attribution_required=False,
                media_type="image",
                retrieved_at=time.strftime("%Y-%m-%d"), search_query=query,
                resolution_label=label,
                raw={},
            ))
        return out
