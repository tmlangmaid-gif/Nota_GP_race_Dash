import os
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field, field_validator


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
    # Backed by the User.is_admin DB column. Synced from ADMIN_EMAILS on
    # backend startup, but only for emails that already correspond to a User
    # row — new signups never auto-promote, even if their email is on the list.
    is_admin: bool = False


class AuthResponse(BaseModel):
    token: str
    user: UserOut


class UpdateMeRequest(BaseModel):
    email: str | None = None
    current_password: str | None = None
    new_password: str | None = Field(default=None, min_length=8, max_length=200)


class DeleteMeRequest(BaseModel):
    """Body for DELETE /api/auth/me — current password required to confirm.
    Destroys the user and (via FK cascades) every event they own, every
    membership, and every auth session. Pending invites by email are left in
    place so a re-signup with the same email still picks them up."""
    password: str


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


class EventMembershipOut(BaseModel):
    """Unified row for the 'Shared with' UI — represents either an actual
    EventMember (the invitee already has an account) or a pending EventInvite
    (they don't yet, but will auto-join on signup). Frontend uses `kind` to
    pick which API route to call for PATCH/DELETE.

    The `id` is the EventMember.id when kind='member', else the EventInvite.id."""
    kind: str           # "member" | "invite"
    id: int
    event_id: int
    email: str
    role: str
    user_id: int | None
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
    outlier_multiplier: float | None = None


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    user_id: int | None
    name: str
    natsoft_url: str | None
    our_vehicle_number: str | None
    is_tracking: bool
    tracking_started_at: datetime | None = None
    created_at: datetime
    min_lap_warning_ms: int = 72_000
    is_public: bool = False
    is_paid: bool = False
    outlier_multiplier: float = 2.5
    role: str | None = None   # set per-request by the endpoint: 'owner' | 'write' | 'read'

    @field_validator("is_paid", mode="after")
    @classmethod
    def _override_when_paywall_disabled(cls, v: bool) -> bool:
        # When STRIPE_SECRET_KEY is unset (e.g. local dev) the paywall is dormant
        # — report every event as paid so the frontend modal stays out of the way.
        # The DB column is left untouched; this only changes serialised responses.
        if not os.environ.get("STRIPE_SECRET_KEY"):
            return True
        return v


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


class UserDriverOut(BaseModel):
    """A user's personal pool of drivers — reusable across events."""
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    color: str | None
    created_at: datetime
    last_used_at: datetime


class UserDriverCreate(BaseModel):
    name: str
    color: str | None = None


class UserDriverUpdate(BaseModel):
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


# ---------- Admin panel ----------

class AdminUserOut(BaseModel):
    id: int
    email: str
    created_at: datetime
    event_count: int = 0
    membership_count: int = 0
    is_admin: bool = False


class AdminEventOut(BaseModel):
    id: int
    name: str
    natsoft_url: str | None
    is_tracking: bool
    is_paid: bool
    is_public: bool
    created_at: datetime
    owner_email: str
    member_count: int = 0


class BypassCodeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    code: str
    description: str | None
    created_at: datetime


class BypassCodeCreate(BaseModel):
    code: str
    description: str | None = None


class AdminAuditLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    ts: datetime
    actor_email: str
    action: str
    target_kind: str | None
    target_id: int | None
    detail: str | None
