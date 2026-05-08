"""
Playwright-based scraper for Natsoft's live timing pages.

Natsoft's UI renders timing data as absolutely-positioned <div> elements
(no HTML tables), driven by a binary WebSocket. The actual live data lives
in an iframe at:

    http://server.natsoft.com.au:8080/LiveMeeting/YYYYMMDD.VENUECODE

Point the scraper at that URL directly and it Just Works.

If the user gives us the parent page URL (e.g. http://racing.natsoft.com.au/results/)
we try to load it and find the iframe — but the parent page only renders the
LiveMeeting iframe AFTER the user clicks through (Discipline → meeting Live link),
so this auto-discovery usually fails and we surface a clear error.

There is also a demo mode: pass `demo://` (or any URL starting with `demo://`)
as the natsoft_url to generate synthetic lap data for testing the dashboard
without a live race.
"""

from __future__ import annotations

import asyncio
import logging
import random
import re
from datetime import datetime, timedelta
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import Event, Lap, ScraperLog, TrackedCar


# ---------------------------------------------------------------------------
# Scraper activity log (visible in-app, separate from logger output)
# ---------------------------------------------------------------------------

SCRAPER_LOG_CAP_PER_EVENT = 200


def log_event(event_id: int, level: str, message: str) -> None:
    """Persist a scraper event for in-app display. Caps the per-event row
    count at SCRAPER_LOG_CAP_PER_EVENT to keep the table bounded."""
    try:
        with SessionLocal() as db:
            db.add(ScraperLog(event_id=event_id, level=level, message=message[:500]))
            # Bound table size: prune oldest rows once we exceed the cap.
            ids = db.execute(
                select(ScraperLog.id)
                .where(ScraperLog.event_id == event_id)
                .order_by(ScraperLog.ts.desc())
                .offset(SCRAPER_LOG_CAP_PER_EVENT)
            ).scalars().all()
            if ids:
                from sqlalchemy import delete as sa_delete
                db.execute(sa_delete(ScraperLog).where(ScraperLog.id.in_(ids)))
            db.commit()
    except Exception:
        # Logging failures must never break the scraper loop.
        logger.exception("failed to write scraper_log row")

logger = logging.getLogger("scraper")

POLL_INTERVAL_SEC = 3.0
PAGE_LOAD_TIMEOUT_MS = 30_000
TABLE_WAIT_TIMEOUT_MS = 20_000

# Hard cap on how long a single tracking session runs without intervention.
# Scrapers exit themselves after this elapsed wall-clock time and clear the
# event's is_tracking flag. The user has to click "Start tracking" again to
# resume — protects us from forgotten scrapers running indefinitely.
TRACKING_AUTO_STOP_HOURS = 12


def _compute_auto_stop_deadline(event_id: int) -> datetime:
    """Read tracking_started_at from the DB and return the wall-clock moment
    at which this scraper task must stop. Falls back to 'now' if the column
    is unset, so the deadline is always 12 hours from start."""
    with SessionLocal() as db:
        ev = db.get(Event, event_id)
        start_at = ev.tracking_started_at if (ev and ev.tracking_started_at) else datetime.utcnow()
    return start_at + timedelta(hours=TRACKING_AUTO_STOP_HOURS)


def _mark_tracking_stopped(event_id: int) -> None:
    with SessionLocal() as db:
        ev = db.get(Event, event_id)
        if ev:
            ev.is_tracking = False
            db.commit()


# ---------------------------------------------------------------------------
# Lap-time parsing
# ---------------------------------------------------------------------------

_TIME_RE = re.compile(
    r"^\s*(?:(?P<m>\d+):)?(?P<s>\d+)(?:[.,](?P<frac>\d{1,3}))?\s*$"
)


def parse_lap_time_ms(value: str) -> int | None:
    """Parse a lap time like '1:23.456', '83.456', or '83,4' into milliseconds."""
    if value is None:
        return None
    m = _TIME_RE.match(str(value).strip())
    if not m:
        return None
    minutes = int(m.group("m") or 0)
    seconds = int(m.group("s"))
    frac = m.group("frac") or "0"
    frac = (frac + "000")[:3]  # pad to 3 digits
    total_ms = (minutes * 60 + seconds) * 1000 + int(frac)
    if total_ms <= 0:
        return None
    return total_ms


# ---------------------------------------------------------------------------
# Live-timing extractor (positioned-div layout)
# ---------------------------------------------------------------------------
#
# Natsoft's LiveMeeting page uses absolutely-positioned <div> elements for
# every cell. We:
#   1. Grab every leaf NText/NTextBold div with its on-screen (top, left).
#   2. Group items into rows by Y coordinate (5px tolerance).
#   3. Find the row with "Pos", "Car" and "Best lap" → header row.
#   4. For each subsequent row, walk left-to-right and pattern-match each cell:
#        first integer → Pos
#        next item → Car
#        3-5 letter caps → Class
#        first text containing letters after Class → Driver
#        first integer after Driver → Laps count
#        first time-with-colon → Last lap
#        second time-with-colon → Best lap
#   This pattern survives the column-X-mismatch problem (header text is
#   left-aligned, data values are centred or right-aligned, so they don't
#   share X coordinates with their headers).

# Strict time format that REQUIRES a colon, so the integer "1" can't
# accidentally be classified as a lap time.
_LIVE_TIME_RE = re.compile(r"^(\d+):(\d+)(?:[.,](\d{1,4}))?$")
_INT_RE = re.compile(r"^\d+$")
_CLASS_RE = re.compile(r"^[A-Z]{2,5}$")


def _parse_live_time_ms(text: str) -> int | None:
    if not text:
        return None
    m = _LIVE_TIME_RE.fullmatch(text.strip())
    if not m:
        return None
    minutes = int(m.group(1))
    seconds = int(m.group(2))
    frac = ((m.group(3) or "0") + "000")[:3]
    total = (minutes * 60 + seconds) * 1000 + int(frac)
    return total if total > 0 else None


def _parse_live_row(items: list[dict]) -> dict | None:
    items = sorted(items, key=lambda x: x["left"])
    pos = None
    car = None
    klass = None
    driver = None
    laps_count = None
    times: list[str] = []
    seen_driver = False

    for it in items:
        t = it["text"].strip()
        if pos is None and _INT_RE.fullmatch(t):
            pos = int(t)
            continue
        if car is None:
            car = t
            continue
        if not seen_driver and _CLASS_RE.fullmatch(t):
            klass = t
            continue
        if not seen_driver and re.search(r"[A-Za-z]", t):
            driver = t
            seen_driver = True
            continue
        if seen_driver:
            if _LIVE_TIME_RE.fullmatch(t):
                times.append(t)
                continue
            if _INT_RE.fullmatch(t) and laps_count is None:
                laps_count = int(t)
                continue

    if not (car and laps_count is not None and times):
        return None
    last_lap_ms = _parse_live_time_ms(times[0])
    if last_lap_ms is None:
        return None
    return {
        "vehicle_number": car,
        "lap_number": laps_count,
        "lap_time_ms": last_lap_ms,
        "position": pos,
    }


async def extract_laps(page) -> list[dict]:
    """Pull live-timing rows from Natsoft's positioned-div layout."""
    items = await page.evaluate(
        """() => {
  const out = [];
  for (const el of document.querySelectorAll('[class*="NText"]')) {
    if (el.children.length > 0) continue;     // only leaf text nodes
    const t = el.innerText.trim();
    if (!t) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.push({text: t, top: Math.round(r.top), left: Math.round(r.left)});
  }
  return out;
}"""
    )
    if not items:
        return []

    items.sort(key=lambda x: (x["top"], x["left"]))
    rows: list[list[dict]] = []
    cur: list[dict] = []
    last_top: int | None = None
    for it in items:
        if last_top is None or abs(it["top"] - last_top) <= 5:
            cur.append(it)
            if last_top is None:
                last_top = it["top"]
        else:
            rows.append(cur)
            cur = [it]
            last_top = it["top"]
    if cur:
        rows.append(cur)

    # Find the header row by content fingerprint.
    header_idx = None
    for i, row in enumerate(rows):
        texts = [it["text"].lower() for it in row]
        if "pos" in texts and "car" in texts and any("best" in t for t in texts):
            header_idx = i
            break
    if header_idx is None:
        return []

    out: list[dict] = []
    for row in rows[header_idx + 1:]:
        d = _parse_live_row(row)
        if d:
            out.append(d)
    return out


# ---------------------------------------------------------------------------
# Persisting
# ---------------------------------------------------------------------------

def upsert_laps(db: Session, event_id: int, rows: Iterable[dict]) -> int:
    """Insert new laps; update mutable fields (time/position) on existing rows.

    On INSERT only, if the vehicle is in this event's TrackedCar list and that
    tracked car has a `current_driver_id`, the new lap is auto-tagged with that
    driver. Existing laps' driver allocations are never changed automatically.

    Returns number of rows touched (inserted or updated).
    """
    # Snapshot current-driver and tyre-stint per tracked vehicle so we don't
    # query them per-row.
    tracked_rows = db.execute(
        select(TrackedCar).where(TrackedCar.event_id == event_id)
    ).scalars().all()
    current_driver_by_vehicle: dict[str, int | None] = {
        tc.vehicle_number: tc.current_driver_id for tc in tracked_rows
    }
    tyre_stint_by_vehicle: dict[str, int] = {
        tc.vehicle_number: tc.tyre_stint or 1 for tc in tracked_rows
    }

    touched = 0
    for r in rows:
        vehicle = r["vehicle_number"]
        lap_number = r["lap_number"]
        if lap_number <= 0:
            # Skip rows we couldn't read a lap number for; they would all collide on (event,vehicle,0)
            continue
        existing = db.execute(
            select(Lap).where(
                Lap.event_id == event_id,
                Lap.vehicle_number == vehicle,
                Lap.lap_number == lap_number,
            )
        ).scalar_one_or_none()
        if existing is None:
            db.add(Lap(
                event_id=event_id,
                vehicle_number=vehicle,
                lap_number=lap_number,
                lap_time_ms=r["lap_time_ms"],
                position=r.get("position"),
                completed_at=r.get("completed_at") or datetime.utcnow(),
                driver_id=current_driver_by_vehicle.get(vehicle),
                tyre_stint=tyre_stint_by_vehicle.get(vehicle, 1),
                source="natsoft",
            ))
            touched += 1
        else:
            changed = False
            if existing.lap_time_ms != r["lap_time_ms"]:
                existing.lap_time_ms = r["lap_time_ms"]; changed = True
            if r.get("position") is not None and existing.position != r["position"]:
                existing.position = r["position"]; changed = True
            if changed:
                touched += 1
    db.commit()
    return touched


# ---------------------------------------------------------------------------
# Demo mode (synthetic data — for developing the dashboard without a live race)
# ---------------------------------------------------------------------------

DEMO_MAX_LAPS_PER_CAR = 30  # 5 cars * 30 = 150 laps total


async def run_demo(event_id: int, stop_event: asyncio.Event) -> None:
    cars = ["7", "12", "23", "44", "88"]
    base_times_ms = {c: random.randint(85_000, 105_000) for c in cars}
    lap_counters = {c: 0 for c in cars}
    deadline = _compute_auto_stop_deadline(event_id)
    logger.info(f"event {event_id}: demo scraper started with cars={cars} "
                f"(cap {DEMO_MAX_LAPS_PER_CAR} laps/car, auto-stop at {deadline.isoformat()})")
    log_event(event_id, "info", f"demo scraper started — cars {cars}, cap {DEMO_MAX_LAPS_PER_CAR} laps/car")

    while not stop_event.is_set():
        if datetime.utcnow() >= deadline:
            logger.info(f"event {event_id}: 12-hour auto-stop reached")
            log_event(event_id, "info", f"auto-stopped after {TRACKING_AUTO_STOP_HOURS}h — start tracking again to resume")
            _mark_tracking_stopped(event_id)
            return
        if all(lap_counters[c] >= DEMO_MAX_LAPS_PER_CAR for c in cars):
            logger.info(f"event {event_id}: demo reached {DEMO_MAX_LAPS_PER_CAR} laps/car cap; "
                        f"keeping task alive (stop tracking to release)")
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass
            continue

        rows = []
        for c in cars:
            if lap_counters[c] >= DEMO_MAX_LAPS_PER_CAR:
                continue
            lap_counters[c] += 1
            jitter = random.randint(-2500, 4500)
            base_times_ms[c] = max(80_000, base_times_ms[c] + random.randint(-300, 300))
            rows.append({
                "vehicle_number": c,
                "lap_number": lap_counters[c],
                "lap_time_ms": base_times_ms[c] + jitter,
                "position": None,
                "completed_at": datetime.utcnow(),
            })
        # Approximate position by best time this poll
        rows.sort(key=lambda r: r["lap_time_ms"])
        for i, r in enumerate(rows, 1):
            r["position"] = i

        with SessionLocal() as db:
            upsert_laps(db, event_id, rows)

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=POLL_INTERVAL_SEC)
        except asyncio.TimeoutError:
            pass

    logger.info(f"event {event_id}: demo scraper stopped")


# ---------------------------------------------------------------------------
# Real Playwright scraper
# ---------------------------------------------------------------------------

_LIVE_MEETING_RE = re.compile(r"/LiveMeeting/", re.IGNORECASE)
INITIAL_RENDER_WAIT_SEC = 10  # JS app needs this long to connect WS + paint first frame


async def _resolve_live_meeting_url(page, parent_url: str) -> str | None:
    """If the user gave us a parent results URL, try to load it and pluck the
    LiveMeeting iframe src. Will only work if the parent URL leads directly
    to a session view (rare — usually the user has to click through)."""
    try:
        await page.goto(parent_url, timeout=PAGE_LOAD_TIMEOUT_MS, wait_until="domcontentloaded")
    except Exception as e:
        logger.error(f"failed to load parent URL {parent_url}: {e}")
        return None
    try:
        await page.wait_for_selector('iframe[src*="LiveMeeting"]', timeout=15_000)
    except Exception:
        return None
    try:
        return await page.eval_on_selector('iframe[src*="LiveMeeting"]', "el => el.src")
    except Exception:
        return None


async def run_natsoft(event_id: int, url: str, stop_event: asyncio.Event) -> None:
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        logger.error("playwright is not installed. Run: pip install playwright && playwright install chromium")
        return

    logger.info(f"event {event_id}: natsoft scraper starting for {url}")
    log_event(event_id, "info", f"scraper starting for {url}")
    async with async_playwright() as p:
        try:
            browser = await p.chromium.launch(headless=True)
        except Exception as e:
            logger.error(f"event {event_id}: failed to launch chromium ({e}). "
                         f"Did you run `playwright install chromium`?")
            log_event(event_id, "error", f"failed to launch chromium: {e}")
            return
        context = await browser.new_context()

        # Resolve the target URL: either the user gave us a LiveMeeting URL
        # directly, or we try to find it from a parent results page.
        target_url = url
        if not _LIVE_MEETING_RE.search(url):
            tmp = await context.new_page()
            try:
                discovered = await _resolve_live_meeting_url(tmp, url)
            finally:
                await tmp.close()
            if not discovered:
                logger.error(
                    f"event {event_id}: couldn't auto-discover a LiveMeeting iframe at {url}."
                )
                log_event(event_id, "error",
                          "couldn't auto-discover the LiveMeeting iframe — use the meeting picker.")
                await browser.close()
                return
            target_url = discovered
            logger.info(f"event {event_id}: resolved to {target_url}")
            log_event(event_id, "info", f"resolved to LiveMeeting URL: {target_url}")

        page = await context.new_page()
        try:
            await page.goto(target_url, timeout=PAGE_LOAD_TIMEOUT_MS, wait_until="domcontentloaded")
            # The JS app needs a moment to connect to the WebSocket + render.
            await asyncio.sleep(INITIAL_RENDER_WAIT_SEC)

            deadline = _compute_auto_stop_deadline(event_id)
            logger.info(f"event {event_id}: auto-stop deadline {deadline.isoformat()}")

            last_change_summary: tuple[int, int] | None = None
            while not stop_event.is_set():
                if datetime.utcnow() >= deadline:
                    logger.info(f"event {event_id}: 12-hour auto-stop reached")
                    log_event(event_id, "info", f"auto-stopped after {TRACKING_AUTO_STOP_HOURS}h — start tracking again to resume")
                    _mark_tracking_stopped(event_id)
                    break
                try:
                    rows = await extract_laps(page)
                    if not rows:
                        logger.info(f"event {event_id}: no rows extracted this poll")
                        # Avoid spamming the activity log with identical "no rows" lines.
                        if last_change_summary != (0, 0):
                            log_event(event_id, "info", "poll: no rows extracted yet")
                            last_change_summary = (0, 0)
                    else:
                        with SessionLocal() as db:
                            n = upsert_laps(db, event_id, rows)
                        logger.info(f"event {event_id}: extracted {len(rows)} rows, {n} new/updated")
                        # Only log when something changed, to keep the activity feed signal-rich.
                        if n > 0:
                            log_event(event_id, "info",
                                      f"poll: saw {len(rows)} cars, {n} new/updated lap(s)")
                            last_change_summary = (len(rows), n)
                        elif last_change_summary != (len(rows), 0):
                            log_event(event_id, "info",
                                      f"poll: saw {len(rows)} cars, no changes")
                            last_change_summary = (len(rows), 0)
                except Exception as e:
                    logger.exception(f"event {event_id}: extract loop error: {e}")
                    log_event(event_id, "error", f"extract loop error: {e}")
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=POLL_INTERVAL_SEC)
                except asyncio.TimeoutError:
                    pass
        finally:
            await context.close()
            await browser.close()
    logger.info(f"event {event_id}: natsoft scraper stopped")
    log_event(event_id, "info", "scraper stopped")


# ---------------------------------------------------------------------------
# Manager — one task per tracked event
# ---------------------------------------------------------------------------

class ScraperManager:
    def __init__(self) -> None:
        self._tasks: dict[int, asyncio.Task] = {}
        self._stops: dict[int, asyncio.Event] = {}

    def is_running(self, event_id: int) -> bool:
        t = self._tasks.get(event_id)
        return t is not None and not t.done()

    async def start(self, event_id: int, url: str | None) -> None:
        if self.is_running(event_id):
            return
        stop = asyncio.Event()
        if url and url.startswith("demo://"):
            coro = run_demo(event_id, stop)
        elif url:
            coro = run_natsoft(event_id, url, stop)
        else:
            raise ValueError("event has no natsoft_url set")
        task = asyncio.create_task(coro, name=f"scraper-{event_id}")
        self._tasks[event_id] = task
        self._stops[event_id] = stop

        with SessionLocal() as db:
            ev = db.get(Event, event_id)
            if ev:
                ev.is_tracking = True
                db.commit()

    async def stop(self, event_id: int) -> None:
        stop = self._stops.pop(event_id, None)
        task = self._tasks.pop(event_id, None)
        if stop:
            stop.set()
        if task:
            try:
                await asyncio.wait_for(task, timeout=10)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                task.cancel()
            except Exception:
                logger.exception(f"event {event_id}: scraper task raised on shutdown")

        with SessionLocal() as db:
            ev = db.get(Event, event_id)
            if ev:
                ev.is_tracking = False
                db.commit()

    async def stop_all(self) -> None:
        for eid in list(self._tasks.keys()):
            await self.stop(eid)


manager = ScraperManager()
