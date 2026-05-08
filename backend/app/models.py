from datetime import datetime, timedelta
from sqlalchemy import (
    Integer, String, DateTime, ForeignKey, Boolean, UniqueConstraint, Index
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .db import Base


def default_token_expiry() -> datetime:
    return datetime.utcnow() + timedelta(days=30)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class AuthToken(Base):
    __tablename__ = "auth_tokens"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, default=default_token_expiry, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


def default_reset_token_expiry() -> datetime:
    return datetime.utcnow() + timedelta(hours=1)


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, default=default_reset_token_expiry, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime)


class ScraperLog(Base):
    """A row per scraper-loop event for an Event. Used to render the in-app
    'Scraper activity' panel so users can see the scraper is alive without
    needing terminal access. Capped per-event to avoid unbounded growth."""
    __tablename__ = "scraper_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False, index=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    level: Mapped[str] = mapped_column(String(10), nullable=False)   # info | warn | error
    message: Mapped[str] = mapped_column(String(500), nullable=False)


class Event(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    natsoft_url: Mapped[str | None] = mapped_column(String(500))
    our_vehicle_number: Mapped[str | None] = mapped_column(String(20))
    is_tracking: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # When the most recent start_tracking call fired. Used to enforce the
    # 12-hour auto-stop, and to compute a remaining-time banner on the
    # dashboard. Reset every time tracking is started fresh.
    tracking_started_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    # Laps faster than this are flagged with a red tint as suspicious / record-pace.
    # Default 1:12.000 = 72 000 ms. Adjustable per event via the settings modal.
    min_lap_warning_ms: Mapped[int] = mapped_column(Integer, default=72_000, nullable=False)
    # When true, any logged-in user can read this event (read-only). Owner still
    # has full control and is the only one who can edit. Defaults to private.
    is_public: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Paywall: true once a Stripe checkout has completed for this event, or the
    # owner redeemed a bypass code, or the event was grandfathered in at the
    # time the paywall was first deployed. Sharing a paid event also gives
    # members access (per-event billing, not per-user).
    is_paid: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    drivers: Mapped[list["Driver"]] = relationship(back_populates="event", cascade="all, delete-orphan")
    laps: Mapped[list["Lap"]] = relationship(back_populates="event", cascade="all, delete-orphan")
    tracked_cars: Mapped[list["TrackedCar"]] = relationship(back_populates="event", cascade="all, delete-orphan")
    members: Mapped[list["EventMember"]] = relationship(back_populates="event", cascade="all, delete-orphan")


class EventMember(Base):
    """Grants a non-owner user access to someone else's event.
    role: 'read' (view-only) or 'write' (can edit drivers/laps/tracked but not delete event or change membership)."""
    __tablename__ = "event_members"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(10), nullable=False, default="read")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    event: Mapped[Event] = relationship(back_populates="members")
    user: Mapped[User] = relationship()

    __table_args__ = (
        UniqueConstraint("event_id", "user_id", name="uq_event_member_event_user"),
    )


class BypassCode(Base):
    """A free-unlock code an admin has created via the admin panel.
    Stored alongside the env-var STRIPE_BYPASS_CODES (both are checked in
    apply_code). Storing in DB lets admins add/remove codes from the UI
    without restarting the backend."""
    __tablename__ = "bypass_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(80), unique=True, nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class EventInvite(Base):
    """A pending invite for an email that doesn't yet have a Race Dash account.
    When that user signs up, the signup flow looks up all invites for their
    email and converts each one into an EventMember row, then deletes the
    invite. Lets event owners pre-share access without their teammates needing
    to sign up first.

    Email is stored normalised (lowercased) so lookups during signup are exact."""
    __tablename__ = "event_invites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(10), nullable=False, default="read")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("event_id", "email", name="uq_event_invite_event_email"),
    )


class TrackedCar(Base):
    """A vehicle that *we* are running in the event. Has a 'current driver'
    setting, so newly recorded laps for this vehicle get auto-tagged with that
    driver until it's changed."""
    __tablename__ = "tracked_cars"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    vehicle_number: Mapped[str] = mapped_column(String(20), nullable=False)
    current_driver_id: Mapped[int | None] = mapped_column(ForeignKey("drivers.id", ondelete="SET NULL"))
    slot: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    tyre_stint: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    tyre_started_lap: Mapped[int | None] = mapped_column(Integer)
    description: Mapped[str | None] = mapped_column(String(120))
    name: Mapped[str | None] = mapped_column(String(80))

    event: Mapped[Event] = relationship(back_populates="tracked_cars")
    current_driver: Mapped["Driver | None"] = relationship()

    __table_args__ = (
        UniqueConstraint("event_id", "vehicle_number", name="uq_trackedcar_event_vehicle"),
    )


class Driver(Base):
    __tablename__ = "drivers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    color: Mapped[str | None] = mapped_column(String(20))
    # The car (by vehicle_number) this driver is rostered to. Null = legacy event-wide driver.
    vehicle_number: Mapped[str | None] = mapped_column(String(20), index=True)

    event: Mapped[Event] = relationship(back_populates="drivers")

    __table_args__ = (
        UniqueConstraint("event_id", "name", name="uq_driver_event_name"),
    )


class Lap(Base):
    __tablename__ = "laps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    vehicle_number: Mapped[str] = mapped_column(String(20), nullable=False)
    lap_number: Mapped[int] = mapped_column(Integer, nullable=False)
    lap_time_ms: Mapped[int] = mapped_column(Integer, nullable=False)  # one lap, in milliseconds
    position: Mapped[int | None] = mapped_column(Integer)              # position at time lap completed (if known)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)    # wall-clock time the lap finished (if known)
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("drivers.id", ondelete="SET NULL"))
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    source: Mapped[str] = mapped_column(String(20), default="natsoft", nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    note: Mapped[str | None] = mapped_column(String(500))
    tyre_stint: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    event: Mapped[Event] = relationship(back_populates="laps")
    driver: Mapped[Driver | None] = relationship()

    __table_args__ = (
        UniqueConstraint("event_id", "vehicle_number", "lap_number", name="uq_lap_event_vehicle_lapnum"),
        Index("ix_laps_event_vehicle", "event_id", "vehicle_number"),
    )
