"""Provider registry.

Only providers whose CURRENT official documentation confirms a public API
with permitted automated retrieval are wired as real adapters
(category="api"). Everything else is listed honestly as Manual/Future
(category="manual") — no fake endpoints, no fake keys, no fake green checks.
"""
from __future__ import annotations
from .base import ProviderMeta
from .pexels import PexelsProvider, META as PEXELS_META
from .pixabay import PixabayProvider, META as PIXABAY_META
from .unsplash import UnsplashProvider, META as UNSPLASH_META
from .wikimedia import WikimediaProvider, META as WIKIMEDIA_META
from .openverse import OpenverseProvider, META as OPENVERSE_META

_MANUAL = [
    ProviderMeta(
        key="mixkit", name="Mixkit", needs_api_key=False,
        signup_url="https://mixkit.co/", docs_url="https://mixkit.co/license/",
        license_name="Mixkit License", license_url="https://mixkit.co/license/",
        attribution_required=False,
        quota_notes="No public API offered; manual download only. Mixkit's own terms forbid automated/bot downloading.",
        verified_working=False,
        status_note="Manual: Mixkit offers free downloads but no "
                    "public search API. Paste a direct file link from a "
                    "Mixkit page below, or download manually in your "
                    "browser and use 'Auto Edit My Footage'.",
        media_types=["video"], category="manual", auth_type="none",
        commercial_use="Yes — Mixkit License (see license page).",
        icon="🎞️",
        cdn_hosts=("mixkit.co",),
    ),
    ProviderMeta(
        key="coverr", name="Coverr", needs_api_key=False,
        signup_url="https://coverr.co/", docs_url="https://coverr.co/",
        license_name="Coverr License", license_url="https://coverr.co/license",
        attribution_required=False,
        quota_notes="Coverr's official API is non-commercial use only (per its docs). Not wired in this build.",
        verified_working=False,
        status_note="Manual: Coverr offers an official API, but it "
                    "permits non-commercial use only and requires a clickable "
                    "Coverr logo credit — so it is not wired into this "
                    "commercial-capable editor. Paste a direct file link "
                    "below, or download manually in your browser.",
        media_types=["video"], category="manual", auth_type="none",
        commercial_use="Yes — Coverr License (see license page).",
        icon="🎥",
        cdn_hosts=("coverr.co",),
    ),
    ProviderMeta(
        key="videvo", name="Videvo", needs_api_key=False,
        signup_url="https://www.videvo.net/",
        docs_url="https://www.videvo.net/about-us/",
        license_name="Varies per clip (check clip page)",
        license_url="https://www.videvo.net/about-us/#licenses",
        attribution_required=True,
        quota_notes="No verified public search API; manual download only.",
        verified_working=False,
        status_note="Manual: no verified public search API. License "
                    "varies per clip — check the clip page before use. "
                    "Paste a direct file link below to import it.",
        media_types=["video"], category="manual", auth_type="none",
        commercial_use="Varies per clip — check the clip page.",
        icon="📹",
        cdn_hosts=("videvo.net",),
    ),
    ProviderMeta(
        key="dareful", name="Dareful", needs_api_key=False,
        signup_url="https://dareful.com/", docs_url="https://dareful.com/",
        license_name="Dareful License", license_url="https://dareful.com/",
        attribution_required=False,
        quota_notes="No public API offered; manual download only.",
        verified_working=False,
        status_note="Manual: free 4K downloads but no public search "
                    "API. Paste a direct file link below to import it.",
        media_types=["video"], category="manual", auth_type="none",
        commercial_use="Yes — Dareful License (see site).",
        icon="⛰️",
        cdn_hosts=("dareful.com",),
    ),
    ProviderMeta(
        key="freepik", name="Freepik", needs_api_key=False,
        signup_url="https://www.freepik.com/",
        docs_url="https://www.freepik.com/legal/terms-of-use",
        license_name="Freepik License", license_url="https://www.freepik.com/legal/terms-of-use",
        attribution_required=True,
        quota_notes="Freepik's stock-content API is usage-based paid, and its license forbids including content in a stock library for redistribution.",
        verified_working=False,
        status_note="Manual: Freepik's API has no confirmed free tier "
                    "for automated retrieval. Paste a direct file link "
                    "below to import it, with attribution as their "
                    "license requires.",
        media_types=["video", "image"], category="manual", auth_type="none",
        commercial_use="Free license allows commercial use WITH attribution "
                       "(see Freepik terms).",
        icon="🖼️",
        cdn_hosts=("freepik.com",),
    ),
]

_IMPLEMENTED = {
    "pexels": (PexelsProvider, PEXELS_META),
    "pixabay": (PixabayProvider, PIXABAY_META),
    "unsplash": (UnsplashProvider, UNSPLASH_META),
    "wikimedia": (WikimediaProvider, WIKIMEDIA_META),
    "openverse": (OpenverseProvider, OPENVERSE_META),
}


def all_metas() -> list[ProviderMeta]:
    metas = [m for _, m in _IMPLEMENTED.values()] + _MANUAL
    return metas


def get_adapter(key: str, api_key: str = ""):
    if key in _IMPLEMENTED:
        cls, _ = _IMPLEMENTED[key]
        return cls(api_key)
    raise RuntimeError(f"Provider '{key}' has no implemented adapter in this build")


def get_meta(key: str):
    """Meta for any known provider (API or manual). Raises KeyError if unknown."""
    for _, m in _IMPLEMENTED.values():
        if m.key == key:
            return m
    for m in _MANUAL:
        if m.key == key:
            return m
    raise KeyError(f"Unknown provider '{key}'")


def implemented_keys() -> list[str]:
    return list(_IMPLEMENTED.keys())


def is_implemented(key: str) -> bool:
    return key in _IMPLEMENTED
