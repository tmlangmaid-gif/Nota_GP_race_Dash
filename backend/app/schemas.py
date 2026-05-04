from datetime import datetime
from pydantic import BaseModel, ConfigDict


class EventCreate(BaseModel):
    name: str
    natsoft_url: str | None = None


class EventUpdate(BaseModel):
    name: str | None = None
    natsoft_url: str | None = None
    our_vehicle_number: str | None = None


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    natsoft_url: str | None
    our_vehicle_number: str | None
    is_tracking: bool
    created_at: datetime


class DriverCreate(BaseModel):
    name: str
    color: str | None = None


class DriverOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_id: int
    name: str
    color: str | None


class DriverUpdate(BaseModel):
    name: str | None = None
    color: str | None = None


class LapOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_id: int
    vehicle_number: str
    lap_number: int
    lap_time_ms: int
    position: int | None
    completed_at: datetime | None
    driver_id: int | None
    is_deleted: bool
    source: str
    recorded_at: datetime
    note: str | None = None
    tyre_stint: int = 1


class LapUpdate(BaseModel):
    driver_id: int | None = None
    is_deleted: bool | None = None
    note: str | None = None


class TrackedCarCreate(BaseModel):
    vehicle_number: str
    slot: int = 1
    current_driver_id: int | None = None


class TrackedCarUpdate(BaseModel):
    vehicle_number: str | None = None
    current_driver_id: int | None = None


class TrackedCarOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_id: int
    vehicle_number: str
    current_driver_id: int | None
    slot: int
    tyre_stint: int = 1
    tyre_started_lap: int | None = None


class LeaderboardRow(BaseModel):
    vehicle_number: str
    laps_completed: int
    best_lap_ms: int | None
    last_lap_ms: int | None
    avg_lap_ms: int | None
    position: int | None  # most recent known position
