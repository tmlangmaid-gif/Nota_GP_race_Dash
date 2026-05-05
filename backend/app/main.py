from __future__ import annotations

import logging
import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import bcrypt
from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .db import Base, engine, ensure_column, get_db, SessionLocal
from .models import AuthToken, Driver, Event, EventMember, Lap, TrackedCar, User
from .schemas import (
    AuthResponse,
    DriverCreate, DriverOut, DriverUpdate,
    EventCreate, EventOut, EventUpdate,
    EventMemberCreate, EventMemberOut, EventMemberUpdate,
    LapOut, LapUpdate,
    LeaderboardRow,
    LoginRequest,
    SignupRequest,
    TrackedCarCreate, TrackedCarOut, TrackedCarUpdate,
    UpdateMeRequest,
    UserOut,
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
    ensure_column("tracked_cars", "description", "VARCHAR(120)")
    ensure_column("tracked_cars", "name", "VARCHAR(80)")
    ensure_column("drivers", "vehicle_number", "VARCHAR(20)")
    ensure_column("events", "user_id", "INTEGER")
    ensure_column("events", "min_lap_warning_ms", "INTEGER NOT NULL DEFAULT 72000")
    # FALSE (not 0) — Postgres requires a boolean literal here; SQLite accepts both.
    ensure_column("events", "is_public", "BOOLEAN NOT NULL DEFAULT FALSE")
    ensure_column("event_members", "role", "VARCHAR(10) NOT NULL DEFAULT 'read'")
    # On startup, no scraper task is running yet — clear any leftover
    # is_tracking=true rows so the UI doesn't lie.
    from sqlalchemy import update as sa_update
    with SessionLocal() as db:
        db.execute(sa_update(Event).values(is_tracking=False))
        db.commit()
    yield
    await scraper_manager.stop_all()


app = FastAPI(title="Race Dash", lifespan=lifespan)

_origins_env = os.environ.get("ALLOWED_ORIGINS", "*").strip()
allow_origins = ["*"] if _origins_env == "*" else [o.strip() for o in _origins_env.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------

def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def normalise_email(email: str) -> str:
    return email.strip().lower()


def gen_token() -> str:
    return secrets.token_urlsafe(32)


def get_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing or malformed Authorization header")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing token")
    auth_token = db.get(AuthToken, token)
    if not auth_token or auth_token.expires_at < datetime.utcnow():
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or expired token")
    user = db.get(User, auth_token.user_id)
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "user no longer exists")
    return user


ROLE_OWNER = "owner"
ROLE_WRITE = "write"
ROLE_READ = "read"


def role_for(event: Event, user: User, db: Session) -> str | None:
    """Return the caller's role on this event, or None if no access."""
    if event.user_id == user.id:
        return ROLE_OWNER
    member = db.execute(
        select(EventMember).where(
            EventMember.event_id == event.id,
            EventMember.user_id == user.id,
        )
    ).scalar_one_or_none()
    if member:
        return member.role if member.role in (ROLE_READ, ROLE_WRITE) else ROLE_READ
    # Public events grant implicit read access to any logged-in user.
    if event.is_public:
        return ROLE_READ
    return None


def with_role(event: Event, role: str) -> Event:
    """Attach a transient `role` attribute on the ORM instance so the
    EventOut schema (with from_attributes=True) picks it up."""
    event.role = role  # type: ignore[attr-defined]
    return event


def get_user_event_read(event_id: int, user: User, db: Session) -> Event:
    """Read-or-better access: owner, write member, or read member."""
    ev = db.get(Event, event_id)
    if not ev:
        raise HTTPException(404, "event not found")
    role = role_for(ev, user, db)
    if role is None:
        raise HTTPException(404, "event not found")  # don't leak existence
    return with_role(ev, role)


def get_user_event_write(event_id: int, user: User, db: Session) -> Event:
    """Write access: owner or write member only. Read members get 403."""
    ev = db.get(Event, event_id)
    if not ev:
        raise HTTPException(404, "event not found")
    role = role_for(ev, user, db)
    if role is None:
        raise HTTPException(404, "event not found")
    if role == ROLE_READ:
        raise HTTPException(403, "you have read-only access to this event")
    return with_role(ev, role)


def get_user_event_owner(event_id: int, user: User, db: Session) -> Event:
    """Owner-only: deleting the event, managing members, etc."""
    ev = db.get(Event, event_id)
    if not ev:
        raise HTTPException(404, "event not found")
    role = role_for(ev, user, db)
    if role is None:
        raise HTTPException(404, "event not found")
    if role != ROLE_OWNER:
        raise HTTPException(403, "only the event owner can do that")
    return with_role(ev, role)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"ok": True}


# ---------------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------------

@app.post("/api/auth/signup", response_model=AuthResponse)
def signup(payload: SignupRequest, db: Session = Depends(get_db)):
    email = normalise_email(payload.email)
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(400, "invalid email address")
    if len(payload.password) < 8:
        raise HTTPException(400, "password must be at least 8 characters")
    existing = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if existing:
        raise HTTPException(409, "an account with that email already exists")
    user = User(email=email, password_hash=hash_password(payload.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    token = gen_token()
    db.add(AuthToken(token=token, user_id=user.id))
    db.commit()
    return AuthResponse(token=token, user=UserOut.model_validate(user))


@app.post("/api/auth/login", response_model=AuthResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    email = normalise_email(payload.email)
    user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(401, "invalid email or password")
    token = gen_token()
    db.add(AuthToken(token=token, user_id=user.id))
    db.commit()
    return AuthResponse(token=token, user=UserOut.model_validate(user))


@app.post("/api/auth/logout")
def logout(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    # Best-effort: delete the current token if present.
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
        existing = db.get(AuthToken, token)
        if existing:
            db.delete(existing)
            db.commit()
    return {"ok": True}


@app.get("/api/auth/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user


@app.patch("/api/auth/me", response_model=UserOut)
def update_me(
    payload: UpdateMeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    new_email = normalise_email(payload.email) if payload.email is not None else None
    changing_email = new_email is not None and new_email != user.email
    changing_password = payload.new_password is not None

    # Either change requires the user to confirm their current password.
    if changing_email or changing_password:
        if not payload.current_password or not verify_password(payload.current_password, user.password_hash):
            raise HTTPException(401, "current password is incorrect")

    if changing_email:
        if "@" not in new_email or "." not in new_email.split("@")[-1]:
            raise HTTPException(400, "invalid email address")
        existing = db.execute(select(User).where(User.email == new_email)).scalar_one_or_none()
        if existing and existing.id != user.id:
            raise HTTPException(409, "an account with that email already exists")
        user.email = new_email

    if changing_password:
        user.password_hash = hash_password(payload.new_password)

    db.commit()
    db.refresh(user)
    return user


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------

@app.post("/api/events", response_model=EventOut)
def create_event(
    payload: EventCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ev = Event(name=payload.name, natsoft_url=payload.natsoft_url, user_id=user.id)
    db.add(ev)
    db.commit()
    db.refresh(ev)
    return with_role(ev, ROLE_OWNER)


@app.get("/api/events", response_model=list[EventOut])
def list_events(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Returns events owned by the user, events explicitly shared with them,
    *and* public events from other users (implicit read role). Each item
    carries a `role` field so the frontend can show appropriate UI."""
    owned = db.execute(
        select(Event).where(Event.user_id == user.id).order_by(Event.created_at.desc())
    ).scalars().all()
    for ev in owned:
        with_role(ev, ROLE_OWNER)

    shared_rows = db.execute(
        select(Event, EventMember.role)
        .join(EventMember, EventMember.event_id == Event.id)
        .where(EventMember.user_id == user.id)
        .order_by(Event.created_at.desc())
    ).all()
    shared = []
    for ev, role in shared_rows:
        with_role(ev, role if role in (ROLE_READ, ROLE_WRITE) else ROLE_READ)
        shared.append(ev)

    seen_ids = {e.id for e in owned} | {e.id for e in shared}
    public = db.execute(
        select(Event).where(
            Event.is_public.is_(True),
            Event.user_id != user.id,
        ).order_by(Event.created_at.desc())
    ).scalars().all()
    public = [ev for ev in public if ev.id not in seen_ids]
    for ev in public:
        with_role(ev, ROLE_READ)

    combined = owned + shared + public
    combined.sort(key=lambda e: e.created_at, reverse=True)
    return combined


@app.get("/api/events/{event_id}", response_model=EventOut)
def get_event(
    event_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return get_user_event_read(event_id, user, db)


@app.patch("/api/events/{event_id}", response_model=EventOut)
def update_event(
    event_id: int,
    payload: EventUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ev = get_user_event_write(event_id, user, db)
    data = payload.model_dump(exclude_unset=True)
    if "min_lap_warning_ms" in data and data["min_lap_warning_ms"] is not None:
        if data["min_lap_warning_ms"] < 1000 or data["min_lap_warning_ms"] > 600_000:
            raise HTTPException(400, "min_lap_warning_ms must be between 1000 (1s) and 600000 (10min)")
    for field, value in data.items():
        setattr(ev, field, value)
    db.commit()
    db.refresh(ev)
    return ev


@app.delete("/api/events/{event_id}")
async def delete_event(
    event_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ev = get_user_event_owner(event_id, user, db)
    if scraper_manager.is_running(event_id):
        await scraper_manager.stop(event_id)
    db.delete(ev)
    db.commit()
    return {"ok": True}


@app.post("/api/events/{event_id}/start_tracking", response_model=EventOut)
async def start_tracking(
    event_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ev = get_user_event_write(event_id, user, db)
    if not ev.natsoft_url:
        raise HTTPException(400, "set natsoft_url on the event first (or use demo:// for synthetic data)")
    await scraper_manager.start(event_id, ev.natsoft_url)
    db.refresh(ev)
    return ev


@app.post("/api/events/{event_id}/stop_tracking", response_model=EventOut)
async def stop_tracking(
    event_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ev = get_user_event_write(event_id, user, db)
    await scraper_manager.stop(event_id)
    db.refresh(ev)
    return ev


# ---------------------------------------------------------------------------
# Event sharing (members)
# ---------------------------------------------------------------------------

def _member_to_out(m: EventMember, db: Session) -> EventMemberOut:
    """Build the EventMemberOut, fetching the user's email by id."""
    u = db.get(User, m.user_id)
    return EventMemberOut(
        id=m.id,
        event_id=m.event_id,
        user_id=m.user_id,
        email=u.email if u else "(unknown)",
        role=m.role,
        created_at=m.created_at,
    )


@app.get("/api/events/{event_id}/members", response_model=list[EventMemberOut])
def list_event_members(
    event_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Anyone with read access can see who has access (so non-owners know who's in their team)."""
    get_user_event_read(event_id, user, db)
    members = db.execute(
        select(EventMember).where(EventMember.event_id == event_id).order_by(EventMember.created_at)
    ).scalars().all()
    return [_member_to_out(m, db) for m in members]


@app.post("/api/events/{event_id}/members", response_model=EventMemberOut)
def add_event_member(
    event_id: int,
    payload: EventMemberCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ev = get_user_event_owner(event_id, user, db)
    role = payload.role.strip().lower()
    if role not in (ROLE_READ, ROLE_WRITE):
        raise HTTPException(400, "role must be 'read' or 'write'")
    invitee_email = normalise_email(payload.email)
    invitee = db.execute(select(User).where(User.email == invitee_email)).scalar_one_or_none()
    if not invitee:
        raise HTTPException(404, "no user with that email — they need to sign up first")
    if invitee.id == ev.user_id:
        raise HTTPException(400, "the owner already has full access")
    existing = db.execute(
        select(EventMember).where(
            EventMember.event_id == event_id,
            EventMember.user_id == invitee.id,
        )
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(409, "this user is already a member; PATCH to change their role")
    m = EventMember(event_id=event_id, user_id=invitee.id, role=role)
    db.add(m)
    db.commit()
    db.refresh(m)
    return _member_to_out(m, db)


@app.patch("/api/events/{event_id}/members/{member_id}", response_model=EventMemberOut)
def update_event_member(
    event_id: int,
    member_id: int,
    payload: EventMemberUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_user_event_owner(event_id, user, db)
    m = db.get(EventMember, member_id)
    if not m or m.event_id != event_id:
        raise HTTPException(404, "member not found")
    role = payload.role.strip().lower()
    if role not in (ROLE_READ, ROLE_WRITE):
        raise HTTPException(400, "role must be 'read' or 'write'")
    m.role = role
    db.commit()
    db.refresh(m)
    return _member_to_out(m, db)


@app.delete("/api/events/{event_id}/members/{member_id}")
def delete_event_member(
    event_id: int,
    member_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_user_event_owner(event_id, user, db)
    m = db.get(EventMember, member_id)
    if not m or m.event_id != event_id:
        raise HTTPException(404, "member not found")
    db.delete(m)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Drivers
# ---------------------------------------------------------------------------

@app.get("/api/events/{event_id}/drivers", response_model=list[DriverOut])
def list_drivers(
    event_id: int,
    vehicle: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_user_event_read(event_id, user, db)
    q = select(Driver).where(Driver.event_id == event_id)
    if vehicle is not None:
        q = q.where(Driver.vehicle_number == vehicle)
    q = q.order_by(Driver.name)
    return db.execute(q).scalars().all()


@app.post("/api/events/{event_id}/drivers", response_model=DriverOut)
def add_driver(
    event_id: int,
    payload: DriverCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_user_event_write(event_id, user, db)
    # Driver names must be unique within (event, vehicle_number) — same name on
    # two different cars is a different driver record (e.g. Alice on #23 vs Alice on #44).
    existing = db.execute(
        select(Driver).where(
            Driver.event_id == event_id,
            Driver.name == payload.name,
            Driver.vehicle_number.is_(payload.vehicle_number) if payload.vehicle_number is None
                else Driver.vehicle_number == payload.vehicle_number,
        )
    ).scalar_one_or_none()
    if existing:
        return existing
    d = Driver(
        event_id=event_id,
        name=payload.name,
        color=payload.color,
        vehicle_number=payload.vehicle_number,
    )
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


@app.patch("/api/drivers/{driver_id}", response_model=DriverOut)
def update_driver(
    driver_id: int,
    payload: DriverUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    d = db.get(Driver, driver_id)
    if not d:
        raise HTTPException(404, "driver not found")
    get_user_event_write(d.event_id, user, db)
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        new_name = data["name"].strip()
        if not new_name:
            raise HTTPException(400, "name cannot be empty")
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


@app.delete("/api/drivers/{driver_id}")
def delete_driver(
    driver_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    d = db.get(Driver, driver_id)
    if not d:
        raise HTTPException(404, "driver not found")
    get_user_event_write(d.event_id, user, db)
    db.delete(d)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Tracked cars
# ---------------------------------------------------------------------------

@app.get("/api/events/{event_id}/tracked", response_model=list[TrackedCarOut])
def list_tracked(
    event_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_user_event_read(event_id, user, db)
    return db.execute(
        select(TrackedCar).where(TrackedCar.event_id == event_id).order_by(TrackedCar.slot)
    ).scalars().all()


@app.post("/api/events/{event_id}/tracked", response_model=TrackedCarOut)
def add_tracked(
    event_id: int,
    payload: TrackedCarCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_user_event_write(event_id, user, db)
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
        description=(payload.description.strip() if payload.description else None),
        name=(payload.name.strip() if payload.name else None),
    )
    db.add(tc)
    db.commit()
    db.refresh(tc)
    return tc


@app.patch("/api/tracked/{tracked_id}", response_model=TrackedCarOut)
def update_tracked(
    tracked_id: int,
    payload: TrackedCarUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    tc = db.get(TrackedCar, tracked_id)
    if not tc:
        raise HTTPException(404, "tracked car not found")
    get_user_event_write(tc.event_id, user, db)
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
    if "description" in data:
        v = (data["description"] or "").strip()
        tc.description = v if v else None
    if "name" in data:
        v = (data["name"] or "").strip()
        tc.name = v if v else None
    db.commit()
    db.refresh(tc)
    return tc


@app.post("/api/tracked/{tracked_id}/tyre_change", response_model=TrackedCarOut)
def tyre_change(
    tracked_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    tc = db.get(TrackedCar, tracked_id)
    if not tc:
        raise HTTPException(404, "tracked car not found")
    get_user_event_write(tc.event_id, user, db)
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
def delete_tracked(
    tracked_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    tc = db.get(TrackedCar, tracked_id)
    if not tc:
        raise HTTPException(404, "tracked car not found")
    get_user_event_write(tc.event_id, user, db)
    db.delete(tc)
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
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_user_event_read(event_id, user, db)
    q = select(Lap).where(Lap.event_id == event_id)
    if not include_deleted:
        q = q.where(Lap.is_deleted.is_(False))
    if vehicle:
        q = q.where(Lap.vehicle_number == vehicle)
    q = q.order_by(Lap.vehicle_number, Lap.lap_number)
    return db.execute(q).scalars().all()


@app.get("/api/events/{event_id}/vehicles", response_model=list[str])
def list_vehicles(
    event_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_user_event_read(event_id, user, db)
    rows = db.execute(
        select(Lap.vehicle_number)
        .where(Lap.event_id == event_id)
        .distinct()
    ).scalars().all()
    def keyf(v: str):
        try:
            return (0, int(v))
        except ValueError:
            return (1, v)
    return sorted(rows, key=keyf)


@app.patch("/api/laps/{lap_id}", response_model=LapOut)
def update_lap(
    lap_id: int,
    payload: LapUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    lap = db.get(Lap, lap_id)
    if not lap:
        raise HTTPException(404, "lap not found")
    get_user_event_write(lap.event_id, user, db)
    data = payload.model_dump(exclude_unset=True)
    if "driver_id" in data and data["driver_id"] is not None:
        d = db.get(Driver, data["driver_id"])
        if not d or d.event_id != lap.event_id:
            raise HTTPException(400, "driver_id does not belong to this event")
    if "note" in data and data["note"] is not None:
        s = data["note"].strip()
        data["note"] = s if s else None
    for k, v in data.items():
        setattr(lap, k, v)
    db.commit()
    db.refresh(lap)
    return lap


@app.delete("/api/laps/{lap_id}")
def soft_delete_lap(
    lap_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    lap = db.get(Lap, lap_id)
    if not lap:
        raise HTTPException(404, "lap not found")
    get_user_event_write(lap.event_id, user, db)
    lap.is_deleted = True
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Leaderboard
# ---------------------------------------------------------------------------

@app.get("/api/events/{event_id}/leaderboard", response_model=list[LeaderboardRow])
def leaderboard(
    event_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_user_event_read(event_id, user, db)
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

    @app.get("/login")
    def login_page():
        return FileResponse(FRONTEND_DIR / "login.html")

    @app.get("/dashboard")
    def dashboard():
        return FileResponse(FRONTEND_DIR / "dashboard.html")

    @app.get("/settings")
    def settings_page():
        return FileResponse(FRONTEND_DIR / "settings.html")

    @app.get("/competitors")
    def competitors_page():
        return FileResponse(FRONTEND_DIR / "competitors.html")
