"""Shared HTTP client for provider API calls.

Why this exists: Pexels / Pixabay / Unsplash sit behind Cloudflare, which
blocks requests coming from datacenter IPs (e.g. Render) when they present a
non-browser fingerprint (Python's TLS fingerprint + "Python-urllib" UA).
Cloudflare answers with HTTP 403 and an HTML page containing
"error code: 1010" — the API key is never even checked, so re-entering the
key can never fix it.

We are a legitimate API client calling documented endpoints with the user's
own key, so we present a standard browser fingerprint:

- Prefer ``curl_cffi`` with Chrome TLS impersonation when installed
  (defeats JA3/TLS-fingerprint bot detection).
- Fall back to urllib with a Chrome User-Agent + Accept headers.

Raises :class:`ProviderHttpError` (carries ``code`` and ``body``) on HTTP
errors so callers keep their existing per-status handling.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)

BROWSER_HEADERS = {
    "User-Agent": BROWSER_UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
}


class ProviderHttpError(Exception):
    """HTTP error from a provider API call. ``code`` is the status,
    ``body`` a short snippet of the response body (often a Cloudflare page)."""

    def __init__(self, code: int, body: str):
        self.code = code
        self.body = (body or "")[:300]
        super().__init__(f"HTTP {code}: {self.body}")


def _via_curl_cffi(full_url: str, headers: dict, timeout: int):
    """Chrome-impersonated GET. Raises ImportError when curl_cffi missing."""
    from curl_cffi import requests as _cr  # type: ignore

    resp = _cr.get(full_url, headers=headers, timeout=timeout,
                   impersonate="chrome")
    return resp.status_code, resp.text or ""


def _via_urllib(full_url: str, headers: dict, timeout: int):
    req = urllib.request.Request(full_url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        raise ProviderHttpError(e.code,
                                e.read().decode("utf-8", "ignore")) from e


def api_get_json(url: str, params: dict | None = None,
                 headers: dict | None = None, timeout: int = 25) -> dict:
    """GET ``url`` with browser fingerprint, return parsed JSON.

    Raises ProviderHttpError on HTTP >= 400, json errors propagate as-is.
    """
    full = url + ("?" + urllib.parse.urlencode(params) if params else "")
    merged = dict(BROWSER_HEADERS)
    merged.update(headers or {})
    t0 = time.time()
    try:
        try:
            code, text = _via_curl_cffi(full, merged, timeout)
        except ImportError:
            # curl_cffi not installed — plain urllib with browser headers
            return _parse(_via_urllib(full, merged, timeout))
        if code >= 400:
            raise ProviderHttpError(code, text)
        return _parse((code, text))
    finally:
        _ = time.time() - t0  # timing kept by callers via note_call()


def _parse(pair) -> dict:
    _code, text = pair
    return json.loads(text)
