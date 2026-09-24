"""Pixabay video+image provider adapter (https://pixabay.com/api/docs/).

Free API key required (user supplies it in Settings; stored server-side).
Only documented endpoints are used.
"""
from __future__ import annotations
import time
import urllib.request
import urllib.parse
import urllib.error
import json
from .base import (BaseProvider, ProviderMeta, Candidate, orientation_of,
                   pick_1080p, resolution_label)

META = ProviderMeta(
    key="pixabay",
    name="Pixabay",
    needs_api_key=True,
    signup_url="https://pixabay.com/api/docs/",
    docs_url="https://pixabay.com/api/docs/",
    license_name="Pixabay Content License",
    license_url="https://pixabay.com/service/license/",
    attribution_required=False,
    quota_notes=("Free-tier rate limits are set by Pixabay and may change; see "
                 "the API documentation for current limits. This app queues "
                 "requests and backs off on HTTP 429."),
    verified_working=False,
    status_note="Requires a free Pixabay API key.",
    media_types=["video", "image"],
    category="api",
    auth_type="api_key",
    rate_limit="See Pixabay API documentation for current limits",
    commercial_use="Yes — the Pixabay Content License permits commercial use.",
    redistribution_notes=("Do not redistribute unaltered Content as stock. "
                          "See the Pixabay Content License."),
    icon="🌅",
    cdn_hosts=("pixabay.com",),
)

_VIDEO_API = "https://pixabay.com/api/videos/"
_IMAGE_API = "https://pixabay.com/api/"


class PixabayProvider(BaseProvider):
    meta = META

    def _get(self, url: str, params: dict) -> dict:
        if not self.api_key:
            raise RuntimeError("Pixabay API key not configured")
        params = dict(params)
        params["key"] = self.api_key
        full = url + "?" + urllib.parse.urlencode(params)
        t0 = time.time()
        try:
            with urllib.request.urlopen(full, timeout=25) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "ignore")[:200]
            if e.code == 429:
                self.cooldown(60)
                raise RuntimeError(f"Pixabay rate limit hit (HTTP 429). {body}")
            raise RuntimeError(f"Pixabay HTTP {e.code}: {body}")
        finally:
            self.note_call((time.time() - t0) * 1000)
        return data

    # ------------------------------------------------------------- search
    def search(self, query: str, orientation: str = "landscape",
               per_page: int = 12, page: int = 1,
               media_type: str = "video") -> list[Candidate]:
        if media_type == "image":
            return self._search_images(query, orientation, per_page, page)
        return self._search_videos(query, orientation, per_page, page)

    def _search_videos(self, query, orientation, per_page, page):
        orient = {"landscape": "h", "portrait": "v"}.get(orientation, "all")
        params = {"q": query, "per_page": max(3, min(200, per_page)),
                  "page": page, "orientation": orient, "video_type": "all"}
        data = self._get(_VIDEO_API, params)
        out: list[Candidate] = []
        for v in data.get("hits", []):
            videos = v.get("videos", {}) or {}
            variants = []
            for k in ("large", "medium", "small", "tiny"):
                b = videos.get(k)
                if b and b.get("url"):
                    variants.append((b.get("width", 0) or 0,
                                     b.get("height", 0) or 0, b["url"]))
            pick = pick_1080p(variants)
            if not pick:
                continue
            w, h, link = pick
            tags = [t.strip() for t in (v.get("tags", "") or "").split(",") if t.strip()]
            user = v.get("user", "")
            out.append(Candidate(
                provider="pixabay", asset_id=str(v.get("id")),
                title=" ".join(tags[:6]) or query,
                page_url=v.get("pageURL", ""),
                preview_url=(v.get("userImageURL") or "") or (v.get("previewURL") or ""),
                file_url=link, file_width=w, file_height=h,
                duration=float(v.get("duration", 0) or 0),
                orientation=orientation_of(w, h),
                creator=user,
                creator_url=(f"https://pixabay.com/users/{user}-{v.get('user_id', '')}/"
                             if user else ""),
                license_name="Pixabay Content License",
                attribution_required=False,
                media_type="video",
                retrieved_at=time.strftime("%Y-%m-%d"), search_query=query,
                resolution_label=resolution_label(w, h),
                raw={"tags": tags},
            ))
        return out

    def _search_images(self, query, orientation, per_page, page):
        orient = {"landscape": "h", "portrait": "v"}.get(orientation, "all")
        params = {"q": query, "per_page": max(3, min(200, per_page)),
                  "page": page, "orientation": orient, "image_type": "all",
                  "safesearch": "true"}
        data = self._get(_IMAGE_API, params)
        out: list[Candidate] = []
        for p in data.get("hits", []) or []:
            # Prefer the full-HD rendition (1920px) when the provider offers
            # it; otherwise the large rendition. Never upscale.
            file_url = p.get("fullHDURL") or p.get("largeImageURL")
            if not file_url:
                continue
            w = p.get("imageWidth", 0) or 0
            h = p.get("imageHeight", 0) or 0
            if p.get("fullHDURL"):
                label, w, h = "1080p", 1920, 1080
            else:
                label = resolution_label(w, h) if h else ""
            tags = [t.strip() for t in (p.get("tags", "") or "").split(",") if t.strip()]
            user = p.get("user", "")
            out.append(Candidate(
                provider="pixabay", asset_id=str(p.get("id")),
                title=" ".join(tags[:6]) or query,
                page_url=p.get("pageURL", ""),
                preview_url=p.get("previewURL") or "",
                file_url=file_url, file_width=w, file_height=h,
                duration=0.0, orientation=orientation_of(w or 16, h or 9),
                creator=user,
                creator_url=(f"https://pixabay.com/users/{user}-{p.get('user_id', '')}/"
                             if user else ""),
                license_name="Pixabay Content License",
                attribution_required=False,
                media_type="image",
                retrieved_at=time.strftime("%Y-%m-%d"), search_query=query,
                resolution_label=label,
                raw={"tags": tags},
            ))
        return out
