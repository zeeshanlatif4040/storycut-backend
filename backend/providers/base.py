"""Base adapter interface for B-roll providers.

Every provider implements search and exposes honest capability metadata.
Adapters must never scrape, bypass access controls/DRM, remove watermarks,
or misrepresent API limits or licenses. Only providers whose CURRENT official
documentation confirms a public API with permitted automated retrieval get
category="api". Everything else is category="manual" (manual/future).
"""
from __future__ import annotations
import time
from dataclasses import dataclass, field


@dataclass
class ProviderMeta:
    key: str                 # adapter id, e.g. "pexels"
    name: str                # display name
    needs_api_key: bool
    signup_url: str
    docs_url: str
    license_name: str
    license_url: str
    attribution_required: bool
    quota_notes: str         # only what is documented; never invented
    verified_working: bool   # True only after a real successful API call
    status_note: str = ""
    # --- extended (spec: provider expansion) ---
    media_types: list = field(default_factory=lambda: ["video"])  # video/image
    category: str = "api"    # "api" = real adapter, "manual" = manual/future only
    auth_type: str = "api_key"  # "api_key" | "none"
    rate_limit: str = ""     # documented rate limit, "" when not documented
    commercial_use: str = ""  # documented commercial-use permission summary
    redistribution_notes: str = ""
    icon: str = "🎞️"
    cdn_hosts: tuple = ()     # hosts allowed for asset download (anti open-proxy)


@dataclass
class Candidate:
    provider: str
    asset_id: str
    title: str
    page_url: str
    preview_url: str         # thumbnail / low-res preview image
    file_url: str            # direct downloadable file (1080p-preferred pick)
    file_width: int
    file_height: int
    duration: float
    orientation: str         # "landscape" | "portrait" | "square"
    creator: str
    creator_url: str
    license_name: str
    attribution_required: bool
    media_type: str = "video"  # "video" | "image"
    retrieved_at: str = ""
    search_query: str = ""
    resolution_label: str = ""  # e.g. "1080p"
    raw: dict = field(default_factory=dict)


class BaseProvider:
    meta: ProviderMeta

    def __init__(self, api_key: str = ""):
        self.api_key = api_key or ""
        self._last_call_ms = 0.0
        self._calls = 0
        self._cooldown_until = 0.0

    @property
    def configured(self) -> bool:
        return (not self.meta.needs_api_key) or bool(self.api_key)

    @property
    def in_cooldown(self) -> bool:
        return time.time() < self._cooldown_until

    def cooldown(self, seconds: float):
        """Back off this provider after a rate-limit error."""
        self._cooldown_until = max(self._cooldown_until, time.time() + seconds)

    def search(self, query: str, orientation: str = "landscape",
               per_page: int = 12, page: int = 1,
               media_type: str = "video") -> list[Candidate]:
        """Return ranked raw candidates for query. Raises on failure."""
        raise NotImplementedError

    def test_connection(self) -> tuple[bool, str]:
        try:
            mt = "image" if "image" in self.meta.media_types else "video"
            self.search("test", per_page=1, media_type=mt)
            return True, "OK — real API call succeeded"
        except Exception as e:  # noqa: BLE001 - surfaced to user
            return False, classify_error(str(e))[:300]

    def note_call(self, ms: float):
        self._last_call_ms = ms
        self._calls += 1


def orientation_of(w: int, h: int) -> str:
    if h > w * 1.05:
        return "portrait"
    if w > h * 1.05:
        return "landscape"
    return "square"


def classify_error(msg: str) -> str:
    """Turn a raw provider error into a useful user-facing explanation."""
    m = msg.lower()
    if "429" in m or "rate limit" in m or "too many requests" in m:
        return ("Rate limit reached — the provider is throttling requests. "
                "Wait a bit; the app backs off and tries the next provider. "
                f"({msg[:120]})")
    if "401" in m or "403" in m or "unauthorized" in m or "invalid" in m and "key" in m:
        return (f"Authentication failed — the API key looks invalid or lacks "
                f"permission. Check the key and try again. ({msg[:120]})")
    if "api key" in m and "not configured" in m:
        return ("No API key configured — paste a free key in Settings, "
                "then Test again.")
    if "timed out" in m or "timeout" in m or "urlopen" in m or "network" in m:
        return (f"Network error — could not reach the provider. Check your "
                f"connection; the app will try the next provider. ({msg[:120]})")
    if "404" in m:
        return (f"Provider endpoint not found (HTTP 404) — the API may have "
                f"changed. ({msg[:120]})")
    return msg[:300]


def pick_1080p(variants: list[tuple[int, int, str]]) -> tuple[int, int, str] | None:
    """Pick the download variant closest to 1080p.

    Preference order: exact 1080p height -> nearest below 1080p down to 720p ->
    nearest above 1080p -> anything available. Never invents a variant.
    Returns (width, height, url) or None.
    """
    vs = [(w, h, u) for w, h, u in variants if u and w > 0 and h > 0]
    if not vs:
        return None
    for w, h, u in vs:
        if h == 1080:
            return (w, h, u)
    below = sorted([v for v in vs if 720 <= v[1] < 1080], key=lambda v: -v[1])
    if below:
        return below[0]
    above = sorted([v for v in vs if v[1] > 1080], key=lambda v: v[1])
    if above:
        return above[0]
    return sorted(vs, key=lambda v: -v[1])[0]


def resolution_label(w: int, h: int) -> str:
    if h >= 2160:
        return "4K"
    if h >= 1440:
        return "1440p"
    if h >= 1080:
        return "1080p"
    if h >= 720:
        return "720p"
    return f"{h}p"
