"""Tiny wrapper around the Resend HTTP API. Pure stdlib — no extra deps.

Configured via env vars set on the VPS:
    RESEND_API_KEY        Your Resend API key (required to actually send).
    RESEND_FROM_EMAIL     The "From:" address; must be on a verified Resend domain.
                          Example: "Race Dash <noreply@yourdomain.com>".
    FRONTEND_BASE_URL     Used to build links inside emails. Defaults to the
                          Vercel URL.

If RESEND_API_KEY is missing, send_password_reset_email() logs the reset link
to the backend logs instead of erroring — so during local dev / smoke testing
you can read the link from `docker logs` and complete the flow manually.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request

logger = logging.getLogger("email_sender")

DEFAULT_FRONTEND_BASE_URL = "https://nota-gp-race-dash.vercel.app"


def frontend_base_url() -> str:
    return os.environ.get("FRONTEND_BASE_URL", DEFAULT_FRONTEND_BASE_URL).rstrip("/")


def _post_to_resend(payload: dict) -> dict:
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        raise RuntimeError("RESEND_API_KEY is not set on the backend")
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            # Cloudflare in front of Resend blocks the default Python-urllib UA
            # with a generic "error code: 1010". A real-looking UA passes through.
            "User-Agent": "RaceDash/1.0 (+racedash.srv1595222.hstgr.cloud)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise RuntimeError(f"Resend API error {e.code}: {text}") from e


def send_password_reset_email(to_email: str, token: str) -> None:
    """Email a reset link to the user. Falls back to logging the link if no
    Resend API key is configured (handy for local dev)."""
    reset_url = f"{frontend_base_url()}/reset-password?token={token}"
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        logger.warning(
            "RESEND_API_KEY not set — would have emailed %s with reset link: %s",
            to_email, reset_url,
        )
        return

    from_email = os.environ.get("RESEND_FROM_EMAIL")
    if not from_email:
        raise RuntimeError("RESEND_FROM_EMAIL is not set on the backend")

    html = (
        '<p>Someone (hopefully you) requested a password reset for your Race Dash account.</p>'
        f'<p>If it was you, <a href="{reset_url}">click here to set a new password</a>.</p>'
        '<p>This link expires in 1 hour. If you didn\'t request a reset, you can ignore this email.</p>'
    )
    text = (
        "Someone requested a password reset for your Race Dash account.\n\n"
        f"If it was you, open this link to set a new password (expires in 1 hour):\n\n{reset_url}\n\n"
        "If you didn't request a reset, ignore this email.\n"
    )

    _post_to_resend({
        "from": from_email,
        "to": [to_email],
        "subject": "Race Dash password reset",
        "html": html,
        "text": text,
    })
    logger.info("Password reset email sent to %s", to_email)


def send_event_invite_email(
    to_email: str,
    event_name: str,
    owner_email: str,
    event_id: int,
    has_account: bool,
) -> None:
    """Email an event-invite to a teammate.

    Two flavours, both end up in the same place:
      * has_account=True  -> "you've been added, open your dashboard"
      * has_account=False -> "you've been invited, sign up with this email and
                              you'll see it on your dashboard automatically"

    The recipient identifier is just their email, so the auto-claim on signup
    finds the right invite without any per-email token.

    Falls back to a log line if Resend isn't configured."""
    base = frontend_base_url()
    if has_account:
        link = f"{base}/dashboard?event={event_id}"
        cta = "Open your dashboard"
        first_line = (
            f"{owner_email} added you to <strong>{event_name}</strong> on Race Dash."
        )
        body_extra = (
            "Live laps from this event are now visible on your Race Dash home page."
        )
    else:
        link = f"{base}/login"
        cta = "Sign up to Race Dash"
        first_line = (
            f"{owner_email} has invited you to view <strong>{event_name}</strong> on Race Dash — "
            "a live timing dashboard for racing."
        )
        body_extra = (
            f"Sign up using <strong>this email address</strong> ({to_email}) and "
            f"you'll automatically see <strong>{event_name}</strong> on your dashboard."
        )

    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        logger.warning(
            "RESEND_API_KEY not set — would have emailed %s about invite to event %s (%s): %s",
            to_email, event_id, event_name, link,
        )
        return

    from_email = os.environ.get("RESEND_FROM_EMAIL")
    if not from_email:
        raise RuntimeError("RESEND_FROM_EMAIL is not set on the backend")

    html = (
        f"<p>{first_line}</p>"
        f"<p>{body_extra}</p>"
        f'<p><a href="{link}" style="display:inline-block;padding:10px 18px;background:#2f7bff;color:#fff;border-radius:6px;text-decoration:none">{cta}</a></p>'
        f'<p style="font-size:12px;color:#666">Or paste this link into your browser: {link}</p>'
    )
    text = (
        f"{first_line.replace('<strong>','').replace('</strong>','')}\n\n"
        f"{body_extra.replace('<strong>','').replace('</strong>','')}\n\n"
        f"{cta}: {link}\n"
    )

    subject = (
        f"You've been added to {event_name} on Race Dash"
        if has_account
        else f"{owner_email} invited you to {event_name} on Race Dash"
    )

    _post_to_resend({
        "from": from_email,
        "to": [to_email],
        "subject": subject,
        "html": html,
        "text": text,
    })
    logger.info("Event-invite email sent to %s for event %s", to_email, event_id)
