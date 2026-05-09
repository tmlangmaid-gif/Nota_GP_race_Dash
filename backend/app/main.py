from __future__ import annotations

import logging
import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import bcrypt
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .db import Base, engine, ensure_column, get_db, SessionLocal
from .email_sender import send_event_invite_email, send_password_reset_email
from .natsoft_browser import browser as natsoft_browser
from .models import AuthToken, BypassCode, Driver, Event, EventInvite, EventMember, Lap, PasswordResetToken, ScraperLog, TrackedCar, User, UserDriver
from . import stripe_paywall
from .schemas import (
    AuthResponse,
    DriverCreate, DriverOut, DriverUpdate,
    AdminEventOut, AdminUserOut,
    BypassCodeCreate, BypassCodeOut,
    DeleteMeRequest,
    EventCreate, EventOut, EventUpdate,
    EventMemberCreate, EventMemberOut, EventMembershipOut, EventMemberUpdate,
    ForgotPasswordRequest,
    LapOut, LapUpdate,
    LeaderboardRow,
    LoginRequest,
    ResetPasswordRequest,
    SignupRequest,
    TrackedCarCreate, TrackedCarOut, TrackedCarUpdate,
    UpdateMeRequest,
    UserDriverCreate, UserDriverOut, UserDriverUpdate,
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

    # Paywall column. The on_add callback fires only the very first time the
    # column is created — that's when we grandfather every existing event as
    # paid so current users don't suddenly hit a paywall on races they've
    # already been working on.
    def _grandfather_existing_events():
        from sqlalchemy import update as sa_update
        with SessionLocal() as db:
            db.execute(sa_update(Event).values(is_paid=True))
            db.commit()
            logging.getLogger("paywall").info("Grandfathered all existing events as paid")
    ensure_column(
        "events", "is_paid", "BOOLEAN NOT NULL DEFAULT FALSE",
        on_add=_grandfather_existing_events,
    )

    # Tracking start timestamp + 12-hour auto-stop. On first add, backfill
    # currently-tracking events with NOW() so the new auto-stop kicks in
    # 12h from now, not retroactively.
    def _backfill_tracking_started_at():
        from sqlalchemy import update as sa_update
        with SessionLocal() as db:
            db.execute(
                sa_update(Event)
                .where(Event.is_tracking.is_(True))
                .values(tracking_started_at=datetime.utcnow())
            )
            db.commit()
    ensure_column(
        "events", "tracking_started_at", "TIMESTAMP",
        on_add=_backfill_tracking_started_at,
    )

    # First-run backfill of the UserDriver pool from existing per-event drivers.
    # Cheap idempotent check: only runs if user_drivers is currently empty.
    with SessionLocal() as db:
        if (db.scalar(select(func.count()).select_from(UserDriver)) or 0) == 0:
            seen: dict[tuple[int, str], UserDriver] = {}
            rows = db.execute(
                select(Event.user_id, Driver.name, Driver.color)
                .join(Event, Event.id == Driver.event_id)
                .where(Event.user_id.isnot(None))
            ).all()
            for user_id, name, color in rows:
                if not name or not name.strip():
                    continue
                key = (user_id, name.strip().lower())
                if key in seen:
                    if color and not seen[key].color:
                        seen[key].color = color
                    continue
                ud = UserDriver(user_id=user_id, name=name.strip(), color=color)
                db.add(ud)
                seen[key] = ud
            if seen:
                db.commit()
                logging.getLogger("migrate").info(
                    "Backfilled %d UserDriver rows from existing per-event drivers", len(seen)
                )

    # Resume scrapers that were running before this container restart. This
    # replaces the old "wipe is_tracking on boot" behaviour: backend restarts
    # were silently killing scrapers, leaving the UI with stale lap data.
    # Events past their 12-hour auto-stop window are unflagged instead.
    from datetime import timedelta as _td
    AUTO_STOP_HOURS = 12
    with SessionLocal() as db:
        rows = db.execute(select(Event).where(Event.is_tracking.is_(True))).scalars().all()
        resumable: list[tuple[int, str]] = []
        for ev in rows:
            if not ev.natsoft_url:
                ev.is_tracking = False
                continue
            if ev.tracking_started_at is None:
                # Legacy event tracking before the column existed — start the
                # 12hr clock from now so it eventually auto-stops.
                ev.tracking_started_at = datetime.utcnow()
            elapsed = datetime.utcnow() - ev.tracking_started_at
            if elapsed >= _td(hours=AUTO_STOP_HOURS):
                ev.is_tracking = False
                continue
            resumable.append((ev.id, ev.natsoft_url))
        db.commit()
    for eid, url in resumable:
        try:
            await scraper_manager.start(eid, url)
            logging.getLogger("scraper").info("resumed scraper for event %s after backend restart", eid)
        except Exception:
            logging.getLogger("scraper").exception("failed to resume scraper for event %s", eid)
    yield
    await scraper_manager.stop_all()
    await natsoft_browser.close()


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


# Admin auth — driven entirely by the ADMIN_EMAILS env var (comma-separated,
# case-insensitive). No DB column to keep admin-ness a config concern, not
# data; rotates with a server restart.
def is_admin_email(email: str) -> bool:
    raw = os.environ.get("ADMIN_EMAILS", "")
    return email.strip().lower() in {e.strip().lower() for e in raw.split(",") if e.strip()}


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not is_admin_email(user.email):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin access required")
    return user


def user_to_out(user: User) -> UserOut:
    """Wrap a User in UserOut and stamp `is_admin` from env config."""
    out = UserOut.model_validate(user)
    out.is_admin = is_admin_email(user.email)
    return out


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

    # Auto-claim any pending invites for this email — they're upgraded to real
    # EventMember rows so the new user lands on the home page already a member
    # of every event they were invited to before signing up.
    pending = db.execute(
        select(EventInvite).where(EventInvite.email == email)
    ).scalars().all()
    for inv in pending:
        ev = db.get(Event, inv.event_id)
        # Skip if event is gone (cascade should've cleaned this up, but defensive).
        # Skip if the new user happens to already be the event owner — shouldn't
        # be possible since they just signed up, but be safe.
        if ev is None or ev.user_id == user.id:
            db.delete(inv)
            continue
        already = db.execute(
            select(EventMember).where(
                EventMember.event_id == inv.event_id,
                EventMember.user_id == user.id,
            )
        ).scalar_one_or_none()
        if not already:
            db.add(EventMember(event_id=inv.event_id, user_id=user.id, role=inv.role))
        db.delete(inv)
    if pending:
        db.commit()
        logging.getLogger("invite").info(
            "Auto-claimed %d pending invite(s) for %s", len(pending), email
        )

    token = gen_token()
    db.add(AuthToken(token=token, user_id=user.id))
    db.commit()
    return AuthResponse(token=token, user=user_to_out(user))


@app.post("/api/auth/login", response_model=AuthResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    email = normalise_email(payload.email)
    user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(401, "invalid email or password")
    token = gen_token()
    db.add(AuthToken(token=token, user_id=user.id))
    db.commit()
    return AuthResponse(token=token, user=user_to_out(user))


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
    return user_to_out(user)


@app.delete("/api/auth/me", status_code=204)
async def delete_me(
    payload: DeleteMeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Permanent self-delete. Requires the user's current password to confirm.

    Cascades wipe every event they own, every membership row, every auth
    token, every password-reset token. EventInvites are keyed by email (not
    user_id) so they're left intact — re-signing up with the same email will
    pick them up via the auto-claim in the signup endpoint.

    Any scraper task running for an event this user owns is stopped before
    the database delete."""
    if not verify_password(payload.password, user.password_hash):
        raise HTTPException(401, "current password is incorrect")

    # Stop scrapers for any events this user owns so they don't keep writing
    # to a table that's about to disappear.
    owned_event_ids = db.execute(
        select(Event.id).where(Event.user_id == user.id)
    ).scalars().all()
    for eid in owned_event_ids:
        if scraper_manager.is_running(eid):
            await scraper_manager.stop(eid)

    db.delete(user)
    db.commit()
    return Response(status_code=204)


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
    return user_to_out(user)


# ---------------------------------------------------------------------------
# Password reset
# ---------------------------------------------------------------------------

from sqlalchemy import delete as sa_delete

@app.post("/api/auth/request_password_reset", status_code=204)
def request_password_reset(payload: ForgotPasswordRequest, db: Session = Depends(get_db)):
    """Email the user a one-time reset link if their email is registered.
    We always return 204 so callers can't probe which emails have accounts."""
    email = normalise_email(payload.email)
    user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if user:
        # Optionally clean up old unused tokens for this user before issuing a fresh one.
        db.execute(
            sa_delete(PasswordResetToken).where(
                PasswordResetToken.user_id == user.id,
                PasswordResetToken.used_at.is_(None),
            )
        )
        token = gen_token()
        db.add(PasswordResetToken(token=token, user_id=user.id))
        db.commit()
        try:
            send_password_reset_email(user.email, token)
        except Exception as exc:
            # Don't surface the error to the caller (would leak send-config issues),
            # but log it so the operator can see what failed.
            logging.getLogger("auth").exception("Failed to send reset email: %s", exc)
    return Response(status_code=204)


@app.post("/api/auth/reset_password")
def reset_password(payload: ResetPasswordRequest, db: Session = Depends(get_db)):
    """Validate a reset token, set the new password, mark the token used,
    and invalidate all of this user's existing auth sessions."""
    pr = db.get(PasswordResetToken, payload.token)
    if pr is None or pr.used_at is not None or pr.expires_at < datetime.utcnow():
        raise HTTPException(400, "this reset link is invalid or has expired")
    user = db.get(User, pr.user_id)
    if user is None:
        raise HTTPException(400, "this reset link is invalid")
    user.password_hash = hash_password(payload.new_password)
    pr.used_at = datetime.utcnow()
    # Log out every device for this user (any other live tokens) — standard
    # post-reset hygiene so a stolen session can't survive the reset.
    db.execute(sa_delete(AuthToken).where(AuthToken.user_id == user.id))
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Natsoft meeting picker — used by the New event form
# ---------------------------------------------------------------------------

class NatsoftMeeting(BaseModel):
    slot: int
    date: str
    name: str
    track: str
    has_live: bool


class ResolveNatsoftMeetingRequest(BaseModel):
    discipline: int   # 0 = Circuit Racing, 1 = Bikes
    slot: int


class ResolvedNatsoftMeeting(BaseModel):
    url: str


@app.get("/api/natsoft/meetings", response_model=list[NatsoftMeeting])
async def list_natsoft_meetings(
    discipline: int = 0,
    user: User = Depends(get_current_user),
):
    """Recent meetings from Natsoft. Cached 60s."""
    if discipline not in (0, 1):
        raise HTTPException(400, "discipline must be 0 (Circuit Racing) or 1 (Bikes)")
    try:
        return await natsoft_browser.list_meetings(discipline)
    except Exception as e:
        logging.getLogger("natsoft").exception("list_meetings failed")
        raise HTTPException(503, f"couldn't reach Natsoft: {e}")


@app.post("/api/natsoft/resolve_meeting", response_model=ResolvedNatsoftMeeting)
async def resolve_natsoft_meeting(
    payload: ResolveNatsoftMeetingRequest,
    user: User = Depends(get_current_user),
):
    """Click the Live link for a specific meeting and return the LiveMeeting iframe URL."""
    if payload.discipline not in (0, 1):
        raise HTTPException(400, "discipline must be 0 or 1")
    try:
        url = await natsoft_browser.resolve_meeting_url(payload.discipline, payload.slot)
    except Exception as e:
        logging.getLogger("natsoft").exception("resolve_meeting failed")
        raise HTTPException(503, f"couldn't reach Natsoft: {e}")
    if not url:
        raise HTTPException(404, "this meeting doesn't have a Live link (not currently broadcasting)")
    return ResolvedNatsoftMeeting(url=url)


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
    # Reset the 12-hour auto-stop timer every time tracking is started fresh.
    # If the scraper is already running this is a no-op (manager.start guards
    # on is_running), but we still bump the timer here so a fresh "Start" click
    # gives a fresh 12-hour window even if there was a stale flag.
    ev.tracking_started_at = datetime.utcnow()
    db.commit()
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

def _member_to_out(m: EventMember, db: Session) -> EventMembershipOut:
    """Unified shape: an EventMember row -> kind='member'."""
    u = db.get(User, m.user_id)
    return EventMembershipOut(
        kind="member",
        id=m.id,
        event_id=m.event_id,
        email=u.email if u else "(unknown)",
        role=m.role,
        user_id=m.user_id,
        created_at=m.created_at,
    )


def _invite_to_out(inv: EventInvite) -> EventMembershipOut:
    """Unified shape: an EventInvite row -> kind='invite' (no user_id yet)."""
    return EventMembershipOut(
        kind="invite",
        id=inv.id,
        event_id=inv.event_id,
        email=inv.email,
        role=inv.role,
        user_id=None,
        created_at=inv.created_at,
    )


@app.get("/api/events/{event_id}/members", response_model=list[EventMembershipOut])
def list_event_members(
    event_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Returns both actual members and pending email-invites in a single list,
    each tagged with `kind`. Anyone with read access can see who has access."""
    get_user_event_read(event_id, user, db)
    members = db.execute(
        select(EventMember).where(EventMember.event_id == event_id).order_by(EventMember.created_at)
    ).scalars().all()
    invites = db.execute(
        select(EventInvite).where(EventInvite.event_id == event_id).order_by(EventInvite.created_at)
    ).scalars().all()
    out: list[EventMembershipOut] = [_member_to_out(m, db) for m in members]
    out += [_invite_to_out(i) for i in invites]
    return out


@app.post("/api/events/{event_id}/members", response_model=EventMembershipOut)
def add_event_member(
    event_id: int,
    payload: EventMemberCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Owner adds someone to the event by email.
    * If that email already has a Race Dash account -> creates an EventMember row.
    * If not -> stores an EventInvite that activates when they sign up.
    Either way, sends them a notification email (Resend) with the right link."""
    ev = get_user_event_owner(event_id, user, db)
    role = payload.role.strip().lower()
    if role not in (ROLE_READ, ROLE_WRITE):
        raise HTTPException(400, "role must be 'read' or 'write'")
    invitee_email = normalise_email(payload.email)
    invitee = db.execute(select(User).where(User.email == invitee_email)).scalar_one_or_none()

    if invitee:
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
        try:
            send_event_invite_email(
                to_email=invitee_email,
                event_name=ev.name,
                owner_email=user.email,
                event_id=ev.id,
                has_account=True,
            )
        except Exception as exc:
            logging.getLogger("invite").exception("Failed to send invite email: %s", exc)
        return _member_to_out(m, db)

    # No account yet -> create a pending invite. The signup flow will pick this
    # up and convert it to an EventMember automatically.
    existing_inv = db.execute(
        select(EventInvite).where(
            EventInvite.event_id == event_id,
            EventInvite.email == invitee_email,
        )
    ).scalar_one_or_none()
    if existing_inv:
        raise HTTPException(409, "an invite for that email is already pending")
    inv = EventInvite(event_id=event_id, email=invitee_email, role=role)
    db.add(inv)
    db.commit()
    db.refresh(inv)
    try:
        send_event_invite_email(
            to_email=invitee_email,
            event_name=ev.name,
            owner_email=user.email,
            event_id=ev.id,
            has_account=False,
        )
    except Exception as exc:
        logging.getLogger("invite").exception("Failed to send invite email: %s", exc)
    return _invite_to_out(inv)


@app.patch("/api/events/{event_id}/members/{member_id}", response_model=EventMembershipOut)
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


@app.patch("/api/events/{event_id}/invites/{invite_id}", response_model=EventMembershipOut)
def update_event_invite(
    event_id: int,
    invite_id: int,
    payload: EventMemberUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Change a pending invite's role before the recipient signs up."""
    get_user_event_owner(event_id, user, db)
    inv = db.get(EventInvite, invite_id)
    if not inv or inv.event_id != event_id:
        raise HTTPException(404, "invite not found")
    role = payload.role.strip().lower()
    if role not in (ROLE_READ, ROLE_WRITE):
        raise HTTPException(400, "role must be 'read' or 'write'")
    inv.role = role
    db.commit()
    db.refresh(inv)
    return _invite_to_out(inv)


@app.delete("/api/events/{event_id}/invites/{invite_id}")
def delete_event_invite(
    event_id: int,
    invite_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Withdraw a pending invite before the recipient signs up."""
    get_user_event_owner(event_id, user, db)
    inv = db.get(EventInvite, invite_id)
    if not inv or inv.event_id != event_id:
        raise HTTPException(404, "invite not found")
    db.delete(inv)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Paywall (Stripe)
#
# Per-event $20 AUD pay-per-race. Three endpoints:
#   * POST /api/events/{id}/checkout       — make a Stripe Checkout Session
#   * POST /api/events/{id}/apply_code     — redeem a free-unlock bypass code
#   * POST /api/stripe/webhook             — Stripe -> us, marks event paid
#
# Sharing a paid event automatically grants paid access to its members because
# `is_paid` lives on the event, not on the user.
# ---------------------------------------------------------------------------

class CheckoutOut(BaseModel):
    url: str


@app.post("/api/events/{event_id}/checkout", response_model=CheckoutOut)
def create_checkout(
    event_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Owner pays for the event. Other members can't pay on the owner's behalf —
    this keeps billing simple (one paying user per event)."""
    if not stripe_paywall.is_paywall_active():
        raise HTTPException(503, "paywall is not configured on this server")
    ev = get_user_event_owner(event_id, user, db)
    if ev.is_paid:
        raise HTTPException(409, "this event is already paid for")
    try:
        url = stripe_paywall.create_checkout_session(
            event_id=ev.id,
            event_name=ev.name,
            user_id=user.id,
            user_email=user.email,
        )
    except Exception as e:
        logging.getLogger("paywall").exception("create_checkout failed")
        raise HTTPException(503, f"couldn't create Stripe checkout: {e}")
    return CheckoutOut(url=url)


class ApplyCodeRequest(BaseModel):
    code: str


@app.post("/api/events/{event_id}/apply_code", response_model=EventOut)
def apply_bypass_code(
    event_id: int,
    payload: ApplyCodeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Redeem a free-unlock code (set in STRIPE_BYPASS_CODES). Stripe-managed
    promotion codes for partial discounts are entered at the Stripe Checkout page
    instead — this endpoint is only for codes that bypass payment entirely."""
    ev = get_user_event_owner(event_id, user, db)
    if ev.is_paid:
        # Idempotent — re-applying a code on an already-paid event is a no-op.
        return ev
    # Two sources for bypass codes: env var (STRIPE_BYPASS_CODES) and DB
    # (admin-managed via /admin). Either is sufficient.
    valid = stripe_paywall.is_bypass_code(payload.code)
    if not valid:
        match = db.execute(
            select(BypassCode).where(func.upper(BypassCode.code) == payload.code.strip().upper())
        ).scalar_one_or_none()
        valid = match is not None
    if not valid:
        raise HTTPException(400, "that code isn't valid")
    ev.is_paid = True
    db.commit()
    db.refresh(ev)
    logging.getLogger("paywall").info(
        "Event %s marked paid via bypass code by user %s", ev.id, user.id
    )
    return with_role(ev, ROLE_OWNER)


@app.post("/api/stripe/webhook")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    """Stripe -> us. Marks the event paid when checkout completes.
    The signature header is verified against STRIPE_WEBHOOK_SECRET so we
    don't trust unsigned posts."""
    if not stripe_paywall.is_paywall_active():
        raise HTTPException(503, "paywall is not configured on this server")
    payload = await request.body()
    signature = request.headers.get("stripe-signature", "")
    try:
        event = stripe_paywall.parse_webhook(payload, signature)
    except Exception as e:
        logging.getLogger("paywall").warning("Bad webhook signature: %s", e)
        raise HTTPException(400, "bad signature")

    if event.get("type") == "checkout.session.completed":
        session = event["data"]["object"]
        meta = session.get("metadata") or {}
        try:
            event_id = int(meta.get("event_id", "0"))
        except (TypeError, ValueError):
            event_id = 0
        if event_id:
            ev = db.get(Event, event_id)
            if ev and not ev.is_paid:
                ev.is_paid = True
                db.commit()
                logging.getLogger("paywall").info(
                    "Event %s marked paid via Stripe checkout %s", event_id, session.get("id")
                )
    # Stripe just needs a 2xx — anything else triggers retries.
    return {"received": True}


# ---------------------------------------------------------------------------
# Admin panel
#
# Anyone whose email is in ADMIN_EMAILS env var can hit these. Lets the
# operator see all users / events from the UI and manage DB-backed bypass
# codes without redeploying.
# ---------------------------------------------------------------------------

@app.get("/api/admin/users", response_model=list[AdminUserOut])
def admin_list_users(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    users = db.execute(select(User).order_by(User.created_at.desc())).scalars().all()
    out: list[AdminUserOut] = []
    for u in users:
        events = db.scalar(
            select(func.count()).select_from(Event).where(Event.user_id == u.id)
        ) or 0
        memberships = db.scalar(
            select(func.count()).select_from(EventMember).where(EventMember.user_id == u.id)
        ) or 0
        out.append(AdminUserOut(
            id=u.id, email=u.email, created_at=u.created_at,
            event_count=events, membership_count=memberships,
            is_admin=is_admin_email(u.email),
        ))
    return out


@app.delete("/api/admin/users/{user_id}", status_code=204)
async def admin_delete_user(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Admin force-delete. Cascades wipe events the user owns, every
    membership, every auth token. Admin can't delete themselves through
    here (use /api/auth/me for that to keep the explicit-confirm flow)."""
    if user_id == admin.id:
        raise HTTPException(400, "use Account settings to delete your own account")
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "user not found")
    owned_event_ids = db.execute(
        select(Event.id).where(Event.user_id == target.id)
    ).scalars().all()
    for eid in owned_event_ids:
        if scraper_manager.is_running(eid):
            await scraper_manager.stop(eid)
    db.delete(target)
    db.commit()
    return Response(status_code=204)


@app.get("/api/admin/events", response_model=list[AdminEventOut])
def admin_list_events(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    events = db.execute(select(Event).order_by(Event.created_at.desc())).scalars().all()
    out: list[AdminEventOut] = []
    for e in events:
        owner = db.get(User, e.user_id) if e.user_id else None
        members = db.scalar(
            select(func.count()).select_from(EventMember).where(EventMember.event_id == e.id)
        ) or 0
        out.append(AdminEventOut(
            id=e.id, name=e.name, natsoft_url=e.natsoft_url,
            is_tracking=e.is_tracking, is_paid=e.is_paid, is_public=e.is_public,
            created_at=e.created_at,
            owner_email=(owner.email if owner else "(deleted)"),
            member_count=members,
        ))
    return out


class AdminEventPaidUpdate(BaseModel):
    is_paid: bool


@app.patch("/api/admin/events/{event_id}/paid", response_model=AdminEventOut)
def admin_set_event_paid(
    event_id: int,
    payload: AdminEventPaidUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Manually flip is_paid on any event — useful for comping a friend or
    recovering an event whose Stripe webhook didn't land."""
    ev = db.get(Event, event_id)
    if not ev:
        raise HTTPException(404, "event not found")
    ev.is_paid = bool(payload.is_paid)
    db.commit()
    db.refresh(ev)
    owner = db.get(User, ev.user_id) if ev.user_id else None
    members = db.scalar(
        select(func.count()).select_from(EventMember).where(EventMember.event_id == ev.id)
    ) or 0
    return AdminEventOut(
        id=ev.id, name=ev.name, natsoft_url=ev.natsoft_url,
        is_tracking=ev.is_tracking, is_paid=ev.is_paid, is_public=ev.is_public,
        created_at=ev.created_at,
        owner_email=(owner.email if owner else "(deleted)"),
        member_count=members,
    )


@app.delete("/api/admin/events/{event_id}", status_code=204)
async def admin_delete_event(
    event_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    ev = db.get(Event, event_id)
    if not ev:
        raise HTTPException(404, "event not found")
    if scraper_manager.is_running(ev.id):
        await scraper_manager.stop(ev.id)
    db.delete(ev)
    db.commit()
    return Response(status_code=204)


@app.get("/api/admin/bypass_codes", response_model=list[BypassCodeOut])
def admin_list_bypass_codes(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    return db.execute(
        select(BypassCode).order_by(BypassCode.created_at.desc())
    ).scalars().all()


@app.post("/api/admin/bypass_codes", response_model=BypassCodeOut)
def admin_create_bypass_code(
    payload: BypassCodeCreate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    code = (payload.code or "").strip()
    if not code:
        raise HTTPException(400, "code can't be empty")
    if len(code) > 80:
        raise HTTPException(400, "code is too long (max 80 characters)")
    existing = db.execute(
        select(BypassCode).where(func.upper(BypassCode.code) == code.upper())
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(409, "that code already exists")
    desc = (payload.description or "").strip() or None
    bc = BypassCode(code=code, description=desc, created_by_user_id=admin.id)
    db.add(bc)
    db.commit()
    db.refresh(bc)
    return bc


@app.delete("/api/admin/bypass_codes/{code_id}", status_code=204)
def admin_delete_bypass_code(
    code_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    bc = db.get(BypassCode, code_id)
    if not bc:
        raise HTTPException(404, "code not found")
    db.delete(bc)
    db.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Drivers
# ---------------------------------------------------------------------------

def _upsert_user_driver(db: Session, user_id: int, name: str, color: str | None) -> UserDriver | None:
    """Add or refresh a UserDriver pool entry for `user_id`. Matches case-
    insensitively on name. On hit, updates last_used_at and fills in `color`
    if the existing pool entry has no colour yet. Caller is responsible for
    db.commit()."""
    if not name or not name.strip():
        return None
    name = name.strip()
    existing = db.execute(
        select(UserDriver).where(
            UserDriver.user_id == user_id,
            func.lower(UserDriver.name) == name.lower(),
        )
    ).scalar_one_or_none()
    if existing:
        existing.last_used_at = datetime.utcnow()
        if color and not existing.color:
            existing.color = color
        return existing
    ud = UserDriver(user_id=user_id, name=name, color=color)
    db.add(ud)
    db.flush()
    return ud


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
        # Still touch the user pool so it reflects the latest "last used".
        _upsert_user_driver(db, user.id, existing.name, existing.color)
        db.commit()
        return existing
    # If the user already has a pool entry for this name (perhaps with a colour
    # set from another event), inherit that colour into this per-event Driver
    # so cross-event recognition is visually consistent.
    pool_entry = db.execute(
        select(UserDriver).where(
            UserDriver.user_id == user.id,
            func.lower(UserDriver.name) == payload.name.strip().lower(),
        )
    ).scalar_one_or_none()
    inherited_color = payload.color or (pool_entry.color if pool_entry else None)
    d = Driver(
        event_id=event_id,
        name=payload.name,
        color=inherited_color,
        vehicle_number=payload.vehicle_number,
    )
    db.add(d)
    _upsert_user_driver(db, user.id, payload.name, inherited_color)
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
    # Mirror the rename / colour update back to the user's pool so the next
    # event's quick-pick reflects the change.
    _upsert_user_driver(db, user.id, d.name, d.color)
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
# Personal driver pool ("My drivers")
#
# A per-user list of drivers reusable across events. Auto-populated whenever
# the user adds/edits a driver inside any event. Settings page lets them
# manage it directly. Editing/deleting a pool entry does NOT cascade to per-
# event Driver rows or to historical lap-driver assignments.
# ---------------------------------------------------------------------------

@app.get("/api/drivers/mine", response_model=list[UserDriverOut])
def list_my_drivers(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return db.execute(
        select(UserDriver)
        .where(UserDriver.user_id == user.id)
        .order_by(UserDriver.last_used_at.desc())
    ).scalars().all()


@app.post("/api/drivers/mine", response_model=UserDriverOut)
def create_my_driver(
    payload: UserDriverCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(400, "name cannot be empty")
    existing = db.execute(
        select(UserDriver).where(
            UserDriver.user_id == user.id,
            func.lower(UserDriver.name) == name.lower(),
        )
    ).scalar_one_or_none()
    if existing:
        # Idempotent: refresh last_used_at + colour and return the existing row.
        existing.last_used_at = datetime.utcnow()
        if payload.color and not existing.color:
            existing.color = payload.color
        db.commit()
        db.refresh(existing)
        return existing
    ud = UserDriver(user_id=user.id, name=name, color=payload.color)
    db.add(ud)
    db.commit()
    db.refresh(ud)
    return ud


@app.patch("/api/drivers/mine/{ud_id}", response_model=UserDriverOut)
def update_my_driver(
    ud_id: int,
    payload: UserDriverUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ud = db.get(UserDriver, ud_id)
    if not ud or ud.user_id != user.id:
        raise HTTPException(404, "driver not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        new_name = data["name"].strip()
        if not new_name:
            raise HTTPException(400, "name cannot be empty")
        if new_name.lower() != ud.name.lower():
            clash = db.execute(
                select(UserDriver).where(
                    UserDriver.user_id == user.id,
                    func.lower(UserDriver.name) == new_name.lower(),
                )
            ).scalar_one_or_none()
            if clash and clash.id != ud.id:
                raise HTTPException(409, "you already have a driver with that name")
        ud.name = new_name
    if "color" in data:
        ud.color = data["color"]
    db.commit()
    db.refresh(ud)
    return ud


@app.delete("/api/drivers/mine/{ud_id}", status_code=204)
def delete_my_driver(
    ud_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ud = db.get(UserDriver, ud_id)
    if not ud or ud.user_id != user.id:
        raise HTTPException(404, "driver not found")
    db.delete(ud)
    db.commit()
    return Response(status_code=204)


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

class ScraperLogOut(BaseModel):
    ts: datetime
    level: str
    message: str


@app.get("/api/events/{event_id}/scraper_logs", response_model=list[ScraperLogOut])
def get_scraper_logs(
    event_id: int,
    limit: int = 100,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Recent scraper-activity log lines for this event, newest first."""
    get_user_event_read(event_id, user, db)
    rows = db.execute(
        select(ScraperLog)
        .where(ScraperLog.event_id == event_id)
        .order_by(ScraperLog.ts.desc())
        .limit(min(limit, 500))
    ).scalars().all()
    return [ScraperLogOut(ts=r.ts, level=r.level, message=r.message) for r in rows]


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

    @app.get("/compressed")
    def compressed_page():
        return FileResponse(FRONTEND_DIR / "compressed.html")

    @app.get("/scraper-activity")
    def scraper_activity_page():
        return FileResponse(FRONTEND_DIR / "scraper-activity.html")

    @app.get("/workflow")
    def workflow_page():
        return FileResponse(FRONTEND_DIR / "workflow.html")

    @app.get("/forgot-password")
    def forgot_password_page():
        return FileResponse(FRONTEND_DIR / "forgot-password.html")

    @app.get("/reset-password")
    def reset_password_page():
        return FileResponse(FRONTEND_DIR / "reset-password.html")

    @app.get("/legal")
    def legal_page():
        return FileResponse(FRONTEND_DIR / "legal.html")

    @app.get("/admin")
    def admin_page():
        return FileResponse(FRONTEND_DIR / "admin.html")
