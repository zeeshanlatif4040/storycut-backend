"""Wikimedia Commons image provider adapter.

No API key needed. Uses the official MediaWiki API
(https://www.mediawiki.org/wiki/API:Main_page).
License and attribution are PER FILE (read from each file's metadata and
surfaced on the candidate) — the adapter never assumes a single license.
Please respect the API etiquette (User-Agent, modest request rate).
"""
from __future__ import annotations
import re
import time
import urllib.request
import urllib.parse
import urllib.error
import json
from .base import (BaseProvider, ProviderMeta, Candidate, orientation_of,
                   resolution_label)

META = ProviderMeta(
    key="wikimedia",
    name="Wikimedia Commons",
    needs_api_key=False,
    signup_url="https://commons.wikimedia.org/",
    docs_url="https://www.mediawiki.org/wiki/API:Main_page",
    license_name="Varies per file (shown on each result)",
    license_url="https://commons.wikimedia.org/wiki/Commons:Licensing",
    attribution_required=True,
    quota_notes=("No key required. Request a descriptive User-Agent and keep "
                 "request rates modest per the API etiquette guidelines. "
                 "This app throttles to one request per ~1.5s."),
    verified_working=True,  # verified with a real API call on 2026-09-24
    status_note="Live and verified — no API key needed. Check each file's "
                "license; attribution is usually required.",
    media_types=["image"],
    category="api",
    auth_type="none",
    rate_limit="No hard documented limit; etiquette asks for modest rates",
    commercial_use="Depends on the file — many allow commercial use, some do "
                   "not. Always check the license shown on each result.",
    redistribution_notes=("Reuse is governed by each file's license "
                          "(often CC BY / CC BY-SA)."),
    icon="🌍",
    cdn_hosts=("wikimedia.org",),
)

_API = "https://commons.wikimedia.org/w/api.php"
_UA = "ZeeshanAIWorkflow/1.0 (educational video tool; contact via app settings)"


def _strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s or "").strip()


class WikimediaProvider(BaseProvider):
    meta = META

    def _get(self, params: dict) -> dict:
        params = dict(params)
        params.update({"action": "query", "format": "json", "formatversion": "2"})
        full = _API + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(full, headers={"User-Agent": _UA})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "ignore")[:200]
            if e.code == 429:
                self.cooldown(120)
                raise RuntimeError(f"Wikimedia rate limit hit (HTTP 429). {body}")
            raise RuntimeError(f"Wikimedia HTTP {e.code}: {body}")
        finally:
            self.note_call((time.time() - t0) * 1000)
        return data

    def search(self, query: str, orientation: str = "landscape",
               per_page: int = 12, page: int = 1,
               media_type: str = "video") -> list[Candidate]:
        if media_type == "video":
            raise RuntimeError("Wikimedia adapter currently serves images only.")
        # Etiquette: keep it slow.
        time.sleep(1.2)
        # Bitmap images only, sorted by relevance.
        params = {
            "generator": "search",
            "gsrsearch": f"filetype:bitmap {query}",
            "gsrnamespace": "6",
            "gsrlimit": str(max(1, min(50, per_page))),
            "prop": "imageinfo",
            "iiprop": "url|size|extmetadata",
            "iiurlwidth": "1920",  # 1920px thumbnail rendition for 1080p output
        }
        data = self._get(params)
        pages = ((data.get("query") or {}).get("pages")) or []
        out: list[Candidate] = []
        for p in pages:
            ii = (p.get("imageinfo") or [{}])[0]
            # Prefer the 1920px thumbnail when the original is at least 1080p;
            # otherwise use the original file.
            ow, oh = ii.get("width", 0) or 0, ii.get("height", 0) or 0
            thumb = ii.get("thumburl") or ""
            if oh >= 1080 and thumb:
                file_url, w = thumb, 1920
                h = round(oh * 1920 / ow) if ow else 0
            else:
                file_url, w, h = ii.get("url", ""), ow, oh
            if not file_url:
                continue
            em = ii.get("extmetadata") or {}
            lic = _strip_html((em.get("LicenseShortName") or {}).get("value", ""))
            artist = _strip_html((em.get("Artist") or {}).get("value", ""))
            low = lic.lower()
            pd = ("public domain" in low or low in ("cc0", "cc0 1.0"))
            license_name = lic or "See file page for license"
            title = (p.get("title") or "").replace("File:", "").rsplit(".", 1)[0]
            title = title.replace("_", " ")[:120] or query
            out.append(Candidate(
                provider="wikimedia", asset_id=str(p.get("pageid", "")),
                title=title,
                page_url=(p.get("canonicalurl")
                          or f"https://commons.wikimedia.org/wiki/{urllib.parse.quote((p.get('title') or '').replace(' ', '_'))}"),
                preview_url=ii.get("thumburl") or "",
                file_url=file_url, file_width=w, file_height=h,
                duration=0.0, orientation=orientation_of(w or 16, h or 9),
                creator=artist, creator_url="",
                license_name=license_name,
                attribution_required=not pd,
                media_type="image",
                retrieved_at=time.strftime("%Y-%m-%d"), search_query=query,
                resolution_label=resolution_label(w, h) if h else "",
                raw={"license_url": (em.get("LicenseUrl") or {}).get("value", "")},
            ))
        # orientation filter (API has no orientation param for this search)
        if orientation in ("landscape", "portrait"):
            out = [c for c in out if c.orientation == orientation] or out
        return out
