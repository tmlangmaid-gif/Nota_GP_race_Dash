"""Stripe paywall helpers.

The paywall is "active" only when STRIPE_SECRET_KEY is set in the environment.
With it unset (e.g. local dev) checkout endpoints return 503 and the dashboard
treats every event as paid so nothing else has to know.

Bypass codes (free unlock) are stored in STRIPE_BYPASS_CODES as a comma-separated
list — e.g. ``STRIPE_BYPASS_CODES=FREEDOM2026,TEAM50``. Stripe's own promotion-code
system handles percentage / fixed-amount discounts via ``allow_promotion_codes=True``
on the Checkout Session, so we don't reimplement that here.
"""

from __future__ import annotations

import logging
import os
from typing import Iterable

import stripe

log = logging.getLogger("paywall")


def is_paywall_active() -> bool:
    """When False, every event is treated as paid (paywall not configured yet)."""
    return bool(os.environ.get("STRIPE_SECRET_KEY"))


def _ensure_active() -> None:
    """Raise if a Stripe call is attempted with no secret key configured."""
    key = os.environ.get("STRIPE_SECRET_KEY")
    if not key:
        raise RuntimeError("STRIPE_SECRET_KEY is not set — paywall is not configured")
    stripe.api_key = key


def _bypass_codes() -> set[str]:
    raw = os.environ.get("STRIPE_BYPASS_CODES", "")
    return {c.strip().upper() for c in raw.split(",") if c.strip()}


def is_bypass_code(code: str) -> bool:
    """Check whether `code` is in STRIPE_BYPASS_CODES (case-insensitive)."""
    return (code or "").strip().upper() in _bypass_codes()


def app_base_url() -> str:
    """Where Stripe should send users back to after checkout. Should be the
    public frontend URL (e.g. https://nota-gp-race-dash.vercel.app).
    Falls back to a sensible default for local dev."""
    return os.environ.get("APP_BASE_URL", "http://localhost:8000").rstrip("/")


def create_checkout_session(*, event_id: int, event_name: str, user_id: int, user_email: str) -> str:
    """Create a Stripe Checkout Session for one event and return its URL.

    Uses STRIPE_PRICE_ID (the $20 AUD recurring or one-off Price you create in
    the Stripe dashboard). `metadata.event_id` is what the webhook reads to know
    which event to mark paid."""
    _ensure_active()
    price_id = os.environ.get("STRIPE_PRICE_ID")
    if not price_id:
        raise RuntimeError("STRIPE_PRICE_ID is not set")

    base = app_base_url()
    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{"price": price_id, "quantity": 1}],
        # `allow_promotion_codes=True` lets the user enter Stripe-managed promo codes
        # at checkout for percentage / fixed-amount discounts.
        allow_promotion_codes=True,
        customer_email=user_email,
        metadata={"event_id": str(event_id), "user_id": str(user_id)},
        success_url=f"{base}/dashboard?event={event_id}&paid=1&session_id={{CHECKOUT_SESSION_ID}}",
        cancel_url=f"{base}/dashboard?event={event_id}&paid=cancelled",
    )
    if not session.url:
        raise RuntimeError("Stripe didn't return a Checkout URL")
    return session.url


def parse_webhook(payload: bytes, signature: str) -> dict:
    """Verify the Stripe webhook signature and return the parsed event dict.
    Raises if STRIPE_WEBHOOK_SECRET is missing or signature is invalid."""
    _ensure_active()
    secret = os.environ.get("STRIPE_WEBHOOK_SECRET")
    if not secret:
        raise RuntimeError("STRIPE_WEBHOOK_SECRET is not set")
    return stripe.Webhook.construct_event(payload, signature, secret)
