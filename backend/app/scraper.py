"""
Playwright-based scraper for Natsoft's live timing pages.

Natsoft's results UI is a JS app that renders a live timing table from a binary
WebSocket stream. We sidestep the protocol by loading the page in headless
Chromium and reading the rendered DOM every few seconds.

The DOM extractor (`extract_laps`) is a best-effort generic table parser. The
Natsoft layout varies slightly per event/category, so when you start tracking
your first real event, watch the logs and tweak `extract_laps` if needed.

There is also a demo mode: pass `demo://` (or any URL starting with `demo://`)
as the natsoft_url to generate synthetic lap data for testing the dashboard
without a live race.
"""

from __future__ import annotations

import asyncio
import logging
import random
import re
from datetime import datetime
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import Event, Lap, TrackedCar

logger = logging.getLogger("scraper")

POLL_INTERVAL_SEC = 3.0
PAGE_LOAD_TIMEOUT_MS = 30_000
TABLE_WAIT_TIMEOUT_MS = 20_000


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
# Generic DOM extractor (best-effort; tune per real event)
# ---------------------------------------------------------------------------

LAP_NUM_HEADERS = {"lap", "lap#", "laps", "lap no", "lap no.", "l"}
VEHICLE_HEADERS = {"#", "no", "no.", "car", "car#", "car no", "comp", "no#"}
TIME_HEADERS = {"last", "last lap", "lap time", "time", "last time"}
POSITION_HEADERS = {"pos", "position", "p"}


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def _classify_headers(headers: list[str]) -> dict[str, int]:
    """Map column-purpose to column-index based on header text."""
    cols: dict[str, int] = {}
    for i, h in enumerate(headers):
        n = _norm(h)
        if n in POSITION_HEADERS and "position" not in cols:
            cols["position"] = i
        elif n in VEHICLE_HEADERS and "vehicle" not in cols:
            cols["vehicle"] = i
        elif n in LAP_NUM_HEADERS and "lap_number" not in cols:
            cols["lap_number"] = i
        elif n in TIME_HEADERS and "lap_time" not in cols:
            cols["lap_time"] = i
    return cols


async def extract_laps(page) -> list[dict]:
    """
    Walk every <table> on the page, try to interpret it as a live-timing table,
    and return rows as dicts: {vehicle_number, lap_number, lap_time_ms, position?}.

    Skips tables we can't classify. Logs what it tried so you can iterate.
    """
    tables = await page.query_selector_all("table")
    results: list[dict] = []

    for ti, table in enumerate(tables):
        try:
            header_cells = await table.query_selector_all("thead tr th, thead tr td")
            if not header_cells:
                # Some tables put headers in the first <tr>
                first_row = await table.query_selector("tr")
                if first_row:
                    header_cells = await first_row.query_selector_all("th, td")
            if not header_cells:
                continue
            headers = [await c.inner_text() for c in header_cells]
            cols = _classify_headers(headers)
            if "vehicle" not in cols or "lap_time" not in cols:
                continue

            row_els = await table.query_selector_all("tbody tr")
            if not row_els:
                # Fallback: every row except the first
                all_rows = await table.query_selector_all("tr")
                row_els = all_rows[1:] if len(all_rows) > 1 else []

            for row in row_els:
                cells = await row.query_selector_all("td, th")
                if not cells:
                    continue
                texts = [(await c.inner_text()).strip() for c in cells]
                if max(cols.values()) >= len(texts):
                    continue
                vehicle = texts[cols["vehicle"]].strip()
                if not vehicle or not re.search(r"\w", vehicle):
                    continue
                lap_time_ms = parse_lap_time_ms(texts[cols["lap_time"]])
                if lap_time_ms is None:
                    continue
                lap_number_raw = texts[cols["lap_number"]] if "lap_number" in cols else ""
                try:
                    lap_number = int(re.sub(r"\D", "", lap_number_raw)) if lap_number_raw else 0
                except ValueError:
                    lap_number = 0
                position = None
                if "position" in cols:
                    try:
                        position = int(re.sub(r"\D", "", texts[cols["position"]]))
                    except ValueError:
                        position = None
                results.append({
                    "vehicle_number": vehicle,
                    "lap_number": lap_number,
                    "lap_time_ms": lap_time_ms,
                    "position": position,
                })
        except Exception as e:
            logger.warning(f"table {ti}: extractor failed: {e}")

    return results


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
    logger.info(f"event {event_id}: demo scraper started with cars={cars} "
                f"(cap {DEMO_MAX_LAPS_PER_CAR} laps/car)")

    while not stop_event.is_set():
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

async def run_natsoft(event_id: int, url: str, stop_event: asyncio.Event) -> None:
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        logger.error("playwright is not installed. Run: pip install playwright && playwright install chromium")
        return

    logger.info(f"event {event_id}: natsoft scraper starting for {url}")
    async with async_playwright() as p:
        try:
            browser = await p.chromium.launch(headless=True)
        except Exception as e:
            logger.error(f"event {event_id}: failed to launch chromium ({e}). "
                         f"Did you run `playwright install chromium`?")
            return
        context = await browser.new_context()
        page = await context.new_page()
        try:
            await page.goto(url, timeout=PAGE_LOAD_TIMEOUT_MS, wait_until="domcontentloaded")
            # Give the JS app time to render its first table.
            try:
                await page.wait_for_selector("table", timeout=TABLE_WAIT_TIMEOUT_MS)
            except Exception:
                logger.warning(f"event {event_id}: no <table> appeared within "
                               f"{TABLE_WAIT_TIMEOUT_MS}ms; will keep polling anyway")

            while not stop_event.is_set():
                try:
                    rows = await extract_laps(page)
                    if not rows:
                        logger.info(f"event {event_id}: no rows extracted this poll")
                    else:
                        with SessionLocal() as db:
                            n = upsert_laps(db, event_id, rows)
                            logger.info(f"event {event_id}: extracted {len(rows)} rows, {n} new/updated")
                except Exception as e:
                    logger.exception(f"event {event_id}: extract loop error: {e}")
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=POLL_INTERVAL_SEC)
                except asyncio.TimeoutError:
                    pass
        finally:
            await context.close()
            await browser.close()
    logger.info(f"event {event_id}: natsoft scraper stopped")


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
