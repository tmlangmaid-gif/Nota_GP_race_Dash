from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .db import Base, engine, ensure_column, get_db, SessionLocal
from .models import Event, Driver, Lap, TrackedCar
from .schemas import (
    EventCreate, EventOut, EventUpdate,
    DriverCreate, DriverOut, DriverUpdate,
    LapOut, LapUpdate,
    LeaderboardRow,
    TrackedCarCreate, TrackedCarOut, TrackedCarUpdate,
)
from .scraper import manager as scraper_manager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    # Tiny migrations for columns added after a DB was first created.
    ensure_column("laps", "note", "VARCHAR(500)")
    ensure_column("laps", "tyre_stint", "INTEGER NOT NULL DEFAULT 1")
    ensure_column("tracked_cars", "tyre_stint", "INTEGER NOT NULL DEFAULT 1")
    ensure_column("tracked_cars", "tyre_started_lap", "INTEGER")
    # On startup, no scraper task is running yet — clear any leftover
    # is_tracking=true rows so the UI doesn't lie.
    from sqlalchemy import update as sa_update
    with SessionLocal() as db:
        db.execute(sa_update(Event).values(is_tracking=False))
        db.commit()
    yield
    await scraper_manager.stop_all()


app = FastAPI(title="Race Dash", lifespan=lifespan)

import os
_origins_env = os.environ.get("ALLOWED_ORIGINS", "*").strip()
allow_origins = ["*"] if _origins_env == "*" else [o.strip() for o in _origins_env.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"ok": True}


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------

@app.post("/api/events", response_model=EventOut)
def create_event(payload: EventCreate, db: Session = Depends(get_db)):
    ev = Event(name=payload.name, natsoft_url=payload.natsoft_url)
    db.add(ev)
    db.commit()
    db.refresh(ev)
    return ev


@app.get("/api/events", response_model=list[EventOut])
def list_events(db: Session = Depends(get_db)):
    rows = db.execute(select(Event).order_by(Event.created_at.desc())).scalars().all()
    return rows


@app.get("/api/events/{event_id}", response_model=EventOut)
def get_event(event_id: int, db: Session = Depends(get_db)):
    ev = db.get(Event, event_id)
    if not ev:
        raise HTTPException(404, "event not found")
    return ev


@app.patch("/api/events/{event_id}", response_model=EventOut)
def update_event(event_id: int, payload: EventUpdate, db: Session = Depends(get_db)):
    ev = db.get(Event, event_id)
    if not ev:
        raise HTTPException(404, "event not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(ev, field, value)
    db.commit()
    db.refresh(ev)
    return ev


@app.delete("/api/events/{event_id}")
async def delete_event(event_id: int, db: Session = Depends(get_db)):
    ev = db.get(Event, event_id)
    if not ev:
        raise HTTPException(404, "event not found")
    if scraper_manager.is_running(event_id):
        await scraper_manager.stop(event_id)
    db.delete(ev)
    db.commit()
    return {"ok": True}


@app.post("/api/events/{event_id}/start_tracking", response_model=EventOut)
async def start_tracking(event_id: int, db: Session = Depends(get_db)):
    ev = db.get(Event, event_id)
    if not ev:
        raise HTTPException(404, "event not found")
    if not ev.natsoft_url:
        raise HTTPException(400, "set natsoft_url on the event first (or use demo:// for synthetic data)")
    await scraper_manager.start(event_id, ev.natsoft_url)
    db.refresh(ev)
    return ev


@app.post("/api/events/{event_id}/stop_tracking", response_model=EventOut)
async def stop_tracking(event_id: int, db: Session = Depends(get_db)):
    ev = db.get(Event, event_id)
    if not ev:
        raise HTTPException(404, "event not found")
    await scraper_manager.stop(event_id)
    db.refresh(ev)
    return ev


# ---------------------------------------------------------------------------
# Drivers
# ---------------------------------------------------------------------------

@app.get("/api/events/{event_id}/drivers", response_model=list[DriverOut])
def list_drivers(event_id: int, db: Session = Depends(get_db)):
    return db.execute(
        select(Driver).where(Driver.event_id == event_id).order_by(Driver.name)
    ).scalars().all()


@app.post("/api/events/{event_id}/drivers", response_model=DriverOut)
def add_driver(event_id: int, payload: DriverCreate, db: Session = Depends(get_db)):
    ev = db.get(Event, event_id)
    if not ev:
        raise HTTPException(404, "event not found")
    existing = db.execute(
        select(Driver).where(Driver.event_id == event_id, Driver.name == payload.name)
    ).scalar_one_or_none()
    if existing:
        return existing
    d = Driver(event_id=event_id, name=payload.name, color=payload.color)
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


@app.patch("/api/drivers/{driver_id}", response_model=DriverOut)
def update_driver(driver_id: int, payload: DriverUpdate, db: Session = Depends(get_db)):
    d = db.get(Driver, driver_id)
    if not d:
        raise HTTPException(404, "driver not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        new_name = data["name"].strip()
        if not new_name:
            raise HTTPException(400, "name cannot be empty")
        # Enforce per-event uniqueness only when actually changing
        if new_name != d.name:
            existing = db.execute(
                select(Driver).where(Driver.event_id == d.event_id, Driver.name == new_name)
            ).scalar_one_or_none()
            if existing and existing.id != d.id:
                raise HTTPException(409, "another driver with that name exists in this event")
        d.name = new_name
    if "color" in data:
        d.color = data["color"]
    db.commit()
    db.refresh(d)
    return d


# ---------------------------------------------------------------------------
# Tracked cars
# ---------------------------------------------------------------------------

@app.get("/api/events/{event_id}/tracked", response_model=list[TrackedCarOut])
def list_tracked(event_id: int, db: Session = Depends(get_db)):
    return db.execute(
        select(TrackedCar).where(TrackedCar.event_id == event_id).order_by(TrackedCar.slot)
    ).scalars().all()


@app.post("/api/events/{event_id}/tracked", response_model=TrackedCarOut)
def add_tracked(event_id: int, payload: TrackedCarCreate, db: Session = Depends(get_db)):
    ev = db.get(Event, event_id)
    if not ev:
        raise HTTPException(404, "event not found")
    if not payload.vehicle_number.strip():
        raise HTTPException(400, "vehicle_number is required")
    existing = db.execute(
        select(TrackedCar).where(
            TrackedCar.event_id == event_id,
            TrackedCar.vehicle_number == payload.vehicle_number,
        )
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(409, "this vehicle is already tracked in this event")
    if payload.current_driver_id is not None:
        d = db.get(Driver, payload.current_driver_id)
        if not d or d.event_id != event_id:
            raise HTTPException(400, "current_driver_id does not belong to this event")
    tc = TrackedCar(
        event_id=event_id,
        vehicle_number=payload.vehicle_number.strip(),
        slot=payload.slot,
        current_driver_id=payload.current_driver_id,
    )
    db.add(tc)
    db.commit()
    db.refresh(tc)
    return tc


@app.patch("/api/tracked/{tracked_id}", response_model=TrackedCarOut)
def update_tracked(tracked_id: int, payload: TrackedCarUpdate, db: Session = Depends(get_db)):
    tc = db.get(TrackedCar, tracked_id)
    if not tc:
        raise HTTPException(404, "tracked car not found")
    data = payload.model_dump(exclude_unset=True)
    if "vehicle_number" in data:
        v = (data["vehicle_number"] or "").strip()
        if not v:
            raise HTTPException(400, "vehicle_number cannot be empty")
        if v != tc.vehicle_number:
            existing = db.execute(
                select(TrackedCar).where(
                    TrackedCar.event_id == tc.event_id,
                    TrackedCar.vehicle_number == v,
                )
            ).scalar_one_or_none()
            if existing and existing.id != tc.id:
                raise HTTPException(409, "this vehicle is already tracked in this event")
        tc.vehicle_number = v
    if "current_driver_id" in data:
        if data["current_driver_id"] is not None:
            d = db.get(Driver, data["current_driver_id"])
            if not d or d.event_id != tc.event_id:
                raise HTTPException(400, "current_driver_id does not belong to this event")
        tc.current_driver_id = data["current_driver_id"]
    db.commit()
    db.refresh(tc)
    return tc


@app.post("/api/tracked/{tracked_id}/tyre_change", response_model=TrackedCarOut)
def tyre_change(tracked_id: int, db: Session = Depends(get_db)):
    """Bump the tyre stint for this tracked car. Subsequently inserted laps
    for this vehicle will be tagged with the new stint number. Existing laps
    keep whatever stint they had."""
    tc = db.get(TrackedCar, tracked_id)
    if not tc:
        raise HTTPException(404, "tracked car not found")
    # Find the most recent lap_number for this car (so the UI can show
    # "stint started at lap N").
    latest = db.execute(
        select(Lap.lap_number)
        .where(
            Lap.event_id == tc.event_id,
            Lap.vehicle_number == tc.vehicle_number,
            Lap.is_deleted.is_(False),
        )
        .order_by(Lap.lap_number.desc())
        .limit(1)
    ).scalar_one_or_none()
    tc.tyre_stint = (tc.tyre_stint or 1) + 1
    tc.tyre_started_lap = (latest or 0) + 1
    db.commit()
    db.refresh(tc)
    return tc


@app.delete("/api/tracked/{tracked_id}")
def delete_tracked(tracked_id: int, db: Session = Depends(get_db)):
    tc = db.get(TrackedCar, tracked_id)
    if not tc:
        raise HTTPException(404, "tracked car not found")
    db.delete(tc)
    db.commit()
    return {"ok": True}


@app.delete("/api/drivers/{driver_id}")
def delete_driver(driver_id: int, db: Session = Depends(get_db)):
    d = db.get(Driver, driver_id)
    if not d:
        raise HTTPException(404, "driver not found")
    db.delete(d)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Laps
# ---------------------------------------------------------------------------

@app.get("/api/events/{event_id}/laps", response_model=list[LapOut])
def list_laps(
    event_id: int,
    include_deleted: bool = False,
    vehicle: str | None = None,
    db: Session = Depends(get_db),
):
    q = select(Lap).where(Lap.event_id == event_id)
    if not include_deleted:
        q = q.where(Lap.is_deleted.is_(False))
    if vehicle:
        q = q.where(Lap.vehicle_number == vehicle)
    q = q.order_by(Lap.vehicle_number, Lap.lap_number)
    return db.execute(q).scalars().all()


@app.get("/api/events/{event_id}/vehicles", response_model=list[str])
def list_vehicles(event_id: int, db: Session = Depends(get_db)):
    rows = db.execute(
        select(Lap.vehicle_number)
        .where(Lap.event_id == event_id)
        .distinct()
    ).scalars().all()
    # Sort numerically when possible, else lexically
    def keyf(v: str):
        try:
            return (0, int(v))
        except ValueError:
            return (1, v)
    return sorted(rows, key=keyf)


@app.patch("/api/laps/{lap_id}", response_model=LapOut)
def update_lap(lap_id: int, payload: LapUpdate, db: Session = Depends(get_db)):
    lap = db.get(Lap, lap_id)
    if not lap:
        raise HTTPException(404, "lap not found")
    data = payload.model_dump(exclude_unset=True)
    if "driver_id" in data and data["driver_id"] is not None:
        d = db.get(Driver, data["driver_id"])
        if not d or d.event_id != lap.event_id:
            raise HTTPException(400, "driver_id does not belong to this event")
    if "note" in data and data["note"] is not None:
        # Trim and treat empty strings as a clearing.
        s = data["note"].strip()
        data["note"] = s if s else None
    for k, v in data.items():
        setattr(lap, k, v)
    db.commit()
    db.refresh(lap)
    return lap


@app.delete("/api/laps/{lap_id}")
def soft_delete_lap(lap_id: int, db: Session = Depends(get_db)):
    lap = db.get(Lap, lap_id)
    if not lap:
        raise HTTPException(404, "lap not found")
    lap.is_deleted = True
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Leaderboard (computed live)
# ---------------------------------------------------------------------------

@app.get("/api/events/{event_id}/leaderboard", response_model=list[LeaderboardRow])
def leaderboard(event_id: int, db: Session = Depends(get_db)):
    laps = db.execute(
        select(Lap)
        .where(Lap.event_id == event_id, Lap.is_deleted.is_(False))
        .order_by(Lap.vehicle_number, Lap.lap_number)
    ).scalars().all()

    by_vehicle: dict[str, list[Lap]] = {}
    for l in laps:
        by_vehicle.setdefault(l.vehicle_number, []).append(l)

    rows: list[LeaderboardRow] = []
    for vehicle, vlaps in by_vehicle.items():
        if not vlaps:
            continue
        times = [l.lap_time_ms for l in vlaps]
        last_lap = max(vlaps, key=lambda l: l.lap_number)
        rows.append(LeaderboardRow(
            vehicle_number=vehicle,
            laps_completed=len(vlaps),
            best_lap_ms=min(times) if times else None,
            last_lap_ms=last_lap.lap_time_ms,
            avg_lap_ms=int(sum(times) / len(times)) if times else None,
            position=last_lap.position,
        ))
    # Sort: most laps completed, then best lap
    rows.sort(key=lambda r: (-r.laps_completed, r.best_lap_ms or 10**9))
    return rows


# ---------------------------------------------------------------------------
# Frontend (static files)
# ---------------------------------------------------------------------------

STATIC_DIR = FRONTEND_DIR / "static"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

if FRONTEND_DIR.exists():
    @app.get("/")
    def index():
        return FileResponse(FRONTEND_DIR / "index.html")

    @app.get("/dashboard")
    def dashboard():
        return FileResponse(FRONTEND_DIR / "dashboard.html")
