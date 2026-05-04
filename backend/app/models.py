from datetime import datetime
from sqlalchemy import (
    Integer, String, DateTime, ForeignKey, Boolean, UniqueConstraint, Index
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .db import Base


class Event(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    natsoft_url: Mapped[str | None] = mapped_column(String(500))
    our_vehicle_number: Mapped[str | None] = mapped_column(String(20))
    is_tracking: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    drivers: Mapped[list["Driver"]] = relationship(back_populates="event", cascade="all, delete-orphan")
    laps: Mapped[list["Lap"]] = relationship(back_populates="event", cascade="all, delete-orphan")
    tracked_cars: Mapped[list["TrackedCar"]] = relationship(back_populates="event", cascade="all, delete-orphan")


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
