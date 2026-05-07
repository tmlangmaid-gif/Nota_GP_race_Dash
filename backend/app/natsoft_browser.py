"""Shared headless Chromium for browsing the Natsoft results site.

Used by the in-app meeting picker (NOT the per-event scrape loop — that has
its own dedicated browser). One browser instance is kept alive between API
calls so we don't pay the ~5-second launch cost on every meeting list fetch.

A 60-second TTL cache on the meetings list keeps the picker snappy and avoids
hammering Natsoft when multiple users are picking around the same time.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

logger = logging.getLogger("natsoft_browser")

NATSOFT_HOMEPAGE = "http://racing.natsoft.com.au/results/"
PAGE_TIMEOUT_MS = 30_000
DISCIPLINE_CLICK_WAIT_SEC = 6
IFRAME_WAIT_MS = 15_000

# meetings list cache: keyed by discipline → (timestamp, meetings)
_MEETINGS_CACHE_TTL_SEC = 60.0
_meetings_cache: dict[int, tuple[float, list[dict[str, Any]]]] = {}


class NatsoftBrowser:
    """Singleton wrapper around a headless Chromium kept open between calls."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._pw = None
        self._browser = None

    async def _ensure(self) -> None:
        if self._browser is not None and self._browser.is_connected():
            return
        # Cold start.
        from playwright.async_api import async_playwright
        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.launch(headless=True)
        logger.info("natsoft browser launched")

    async def close(self) -> None:
        async with self._lock:
            if self._browser:
                try:
                    await self._browser.close()
                except Exception:
                    pass
                self._browser = None
            if self._pw:
                try:
                    await self._pw.stop()
                except Exception:
                    pass
                self._pw = None

    async def list_meetings(self, discipline: int) -> list[dict[str, Any]]:
        """Returns the recent meetings list for the given discipline.
        discipline: 0=Circuit Racing, 1=Bikes (those are Natsoft's button ids)."""
        if discipline not in (0, 1):
            raise ValueError("discipline must be 0 or 1")

        cached = _meetings_cache.get(discipline)
        if cached and time.time() - cached[0] < _MEETINGS_CACHE_TTL_SEC:
            return cached[1]

        async with self._lock:
            await self._ensure()
            page = await self._browser.new_page()
            try:
                await page.goto(NATSOFT_HOMEPAGE, timeout=PAGE_TIMEOUT_MS, wait_until="domcontentloaded")
                await asyncio.sleep(DISCIPLINE_CLICK_WAIT_SEC)
                await page.click(f"#Discipline_{discipline}")
                # Wait for any MeetingList row to render.
                await page.wait_for_selector('[id^="MeetingList#r"]', timeout=IFRAME_WAIT_MS)
                meetings = await page.evaluate(
                    """() => {
  const out = [];
  // Collect all row containers MeetingList#rN c1 (the name + track cell).
  const rowEls = document.querySelectorAll('[id^="MeetingList#r"]');
  const seen = new Set();
  for (const el of rowEls) {
    const m = el.id.match(/^MeetingList#r(\\d+)c1$/);
    if (!m) continue;
    const slot = parseInt(m[1], 10);
    if (seen.has(slot)) continue;
    seen.add(slot);

    const dateEl = document.querySelector(`[id="MeetingList#r${slot}c0"] div`);
    const liveEl = document.querySelector(`[id="MeetingList#r${slot}c2"]`);

    // The c1 cell has two inner divs: name (bold) then track.
    const innerDivs = el.querySelectorAll('div');
    const name = innerDivs[0] ? innerDivs[0].innerText.trim() : '';
    const track = innerDivs[1] ? innerDivs[1].innerText.trim() : '';

    // The c2 cell holds either a "Live" link with non-zero count, or empty.
    let has_live = false;
    if (liveEl) {
      const txt = liveEl.innerText.trim().toLowerCase();
      has_live = txt.includes('live');
    }
    const date = dateEl ? dateEl.innerText.trim() : '';
    out.push({ slot, date, name, track, has_live });
  }
  return out;
}"""
                )
            finally:
                await page.close()

        _meetings_cache[discipline] = (time.time(), meetings)
        return meetings

    async def resolve_meeting_url(self, discipline: int, slot: int) -> str | None:
        """Click the 'Live' link for a specific meeting and pluck the iframe src.
        Returns the LiveMeeting URL or None if not resolvable."""
        if discipline not in (0, 1):
            raise ValueError("discipline must be 0 or 1")

        async with self._lock:
            await self._ensure()
            page = await self._browser.new_page()
            try:
                await page.goto(NATSOFT_HOMEPAGE, timeout=PAGE_TIMEOUT_MS, wait_until="domcontentloaded")
                await asyncio.sleep(DISCIPLINE_CLICK_WAIT_SEC)
                await page.click(f"#Discipline_{discipline}")
                await page.wait_for_selector('[id^="MeetingList#r"]', timeout=IFRAME_WAIT_MS)
                # Click the Live link for this row.
                live_selector = f'[id="MeetingList#r{slot}c2"]'
                live_el = await page.query_selector(live_selector)
                if live_el is None:
                    return None
                # Only click if there's a "Live" link to click.
                live_text = (await live_el.inner_text()).strip().lower()
                if "live" not in live_text:
                    return None
                await live_el.click()
                try:
                    await page.wait_for_selector('iframe[src*="LiveMeeting"]', timeout=IFRAME_WAIT_MS)
                except Exception:
                    return None
                return await page.eval_on_selector(
                    'iframe[src*="LiveMeeting"]', "el => el.src"
                )
            finally:
                await page.close()


# Singleton.
browser = NatsoftBrowser()
