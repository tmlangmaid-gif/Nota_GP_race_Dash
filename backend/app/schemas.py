from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field


class SignupRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=200)


class LoginRequest(BaseModel):
    email: str
    password: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: str
    created_at: datetime


class AuthResponse(BaseModel):
    token: str
    user: UserOut


class UpdateMeRequest(BaseModel):
    email: str | None = None
    current_password: str | None = None
    new_password: str | None = Field(default=None, min_length=8, max_length=200)


class ForgotPasswordRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=8, max_length=200)


class EventMemberCreate(BaseModel):
    email: str
    role: str = "read"   # "read" | "write"


class EventMemberUpdate(BaseModel):
    role: str   # "read" | "write"


class EventMemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_id: int
    user_id: int
    email: str
    role: str
    created_at: datetime


class EventCreate(BaseModel):
    name: str
    natsoft_url: str | None = None


class EventUpdate(BaseModel):
    name: str | None = None
    natsoft_url: str | None = None
    our_vehicle_number: str | None = None
    min_lap_warning_ms: int | None = None
    is_public: bool | None = None


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    user_id: int | None
    name: str
    natsoft_url: str | None
    our_vehicle_number: str | None
    is_tracking: bool
    created_at: datetime
    min_lap_warning_ms: int = 72_000
    is_public: bool = False
    role: str | None = None   # set per-request by the endpoint: 'owner' | 'write' | 'read'


class DriverCreate(BaseModel):
    name: str
    color: str | None = None
    vehicle_number: str | None = None


class DriverOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_id: int
    name: str
    color: str | None
    vehicle_number: str | None = None


class DriverUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    vehicle_number: str | None = None


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
    description: str | None = None
    name: str | None = None


class TrackedCarUpdate(BaseModel):
    vehicle_number: str | None = None
    current_driver_id: int | None = None
    description: str | None = None
    name: str | None = None


class TrackedCarOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_id: int
    vehicle_number: str
    current_driver_id: int | None
    slot: int
    tyre_stint: int = 1
    tyre_started_lap: int | None = None
    description: str | None = None
    name: str | None = None


class LeaderboardRow(BaseModel):
    vehicle_number: str
    laps_completed: int
    best_lap_ms: int | None
    last_lap_ms: int | None
    avg_lap_ms: int | None
    position: int | None  # most recent known position
