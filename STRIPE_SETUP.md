# Stripe paywall — setup guide

Race Dash charges **$20 AUD per event** (one-off, per-race-weekend). Sharing a
paid event with team members automatically gives them access — billing is
per-event, not per-user.

This doc walks through wiring up Stripe **in test mode first**, then flipping
to live mode when you're confident.

---

## 1. Create the Stripe account (skip if you already have one)

1. Go to <https://dashboard.stripe.com/register>.
2. Verify your email.
3. **Stay in Test mode** for now — the toggle is in the top-right of the
   dashboard. Anything below is Test mode unless I say otherwise.

---

## 2. Create the $20 AUD Product / Price

1. In the Stripe dashboard sidebar: **Product catalog → Add product**.
2. Name: `Race Dash event unlock`. Description: optional.
3. Pricing model: **One-off**.
4. Price: `20.00` AUD.
5. Save. Open the product, copy the **Price ID** — it starts with `price_…`.
   Save it as `STRIPE_PRICE_ID`.

---

## 3. Get your API keys

In the dashboard: **Developers → API keys** (still in Test mode).

* Copy the **Secret key** (`sk_test_…`). Save as `STRIPE_SECRET_KEY`.
* You don't need the publishable key — Race Dash uses Stripe Checkout (hosted),
  not Stripe Elements, so the publishable key never touches our frontend.

---

## 4. Create the webhook endpoint

This is how Stripe tells us *"payment succeeded"* so we can mark the event paid.

1. **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://racedash.srv1595222.hstgr.cloud/api/stripe/webhook`
   (replace with your actual VPS hostname).
3. Listen for: select **`checkout.session.completed`** only.
4. Save. On the endpoint detail page, click **Reveal signing secret**.
5. Copy the value (starts with `whsec_…`). Save as `STRIPE_WEBHOOK_SECRET`.

---

## 5. Bypass codes (free unlocks for friends / yourself)

These are codes you set yourself that bypass payment entirely. They're separate
from Stripe-managed promotion codes (which apply discounts at checkout — see §7).

`STRIPE_BYPASS_CODES` is a comma-separated list of codes. Case-insensitive.

```
STRIPE_BYPASS_CODES=FREE2026,LANGMAID,NOTABACKER
```

When a user enters one of these in the paywall modal, the event is marked paid
immediately without any Stripe call.

---

## 6. Set the env vars on the VPS

SSH into the VPS and edit `/path/to/Nota_GP_race_Dash/.env`:

```
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxx
STRIPE_PRICE_ID=price_xxxxxxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxx
STRIPE_BYPASS_CODES=FREE2026,LANGMAID
APP_BASE_URL=https://nota-gp-race-dash.vercel.app
```

Notes:
* `APP_BASE_URL` is where Stripe sends users after checkout (the **frontend**
  URL — Vercel — not the backend).
* If `STRIPE_SECRET_KEY` is missing, the paywall is dormant — every event is
  treated as paid. That keeps local dev painless.

After editing, rebuild the backend container so it picks up the new env:

```bash
docker compose -f docker-compose.prod.yml up -d --build backend
```

---

## 7. (Optional) Stripe-managed promotion codes for partial discounts

`allow_promotion_codes=True` is set on every Checkout Session, so:

1. In Stripe dashboard: **Products → Coupons → Create coupon**.
   * Type: `Percentage off` (e.g. 50%) or `Amount off` (e.g. $5 AUD off).
   * Duration: `Once`.
2. Then **Promotion codes → Create promotion code**, attach it to the coupon,
   set the customer-facing code (e.g. `EARLYBIRD50`).
3. Set restrictions if you want (max redemptions, expiry, etc.).

Users enter these codes on the **Stripe Checkout page**, not in the paywall
modal. The modal's "Have a code?" field is for full bypass codes only.

---

## 8. Test the flow end-to-end (Test mode)

1. Open Race Dash, create a new event. Wait 10 seconds — the paywall modal
   should appear.
2. Click **Pay $20 AUD with card**. Stripe Checkout opens.
3. Use the test card: `4242 4242 4242 4242`, any future expiry, any 3-digit CVC,
   any postcode.
4. After completion, you're redirected to `…/dashboard?event=X&paid=1`.
5. The "Payment received" toast appears, the modal closes, and within 1–3
   seconds (when the webhook fires) the event flips to paid permanently.

Other Stripe test cards (full list at <https://docs.stripe.com/testing>):
* `4000 0000 0000 9995` — declined (insufficient funds)
* `4000 0025 0000 3155` — requires 3DS authentication

---

## 9. Local webhook testing (optional)

If you're iterating locally and want webhooks to reach `http://localhost:8000`,
install the Stripe CLI:

```bash
stripe login
stripe listen --forward-to localhost:8000/api/stripe/webhook
```

The CLI prints a temporary `whsec_…` to use as `STRIPE_WEBHOOK_SECRET` in your
local `.env`.

---

## 10. Going live

When you're ready:

1. Switch the dashboard to **Live mode** (top-right toggle).
2. Repeat steps 2-4 in **Live mode** — you'll get new `price_`, `sk_live_`,
   and `whsec_` values.
3. Activate your account (verification, bank details for payouts).
4. Update the VPS `.env` with the live values. Rebuild the backend.
5. Test once with a real card on a real event.

Existing users won't be affected: every event in the database at the time the
paywall column was added has `is_paid = true` (grandfathered).

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Paywall modal never appears | `STRIPE_SECRET_KEY` is unset — backend treats every event as paid (dormant mode) |
| `Couldn't start checkout: …` | `STRIPE_PRICE_ID` missing or wrong, or `APP_BASE_URL` not reachable |
| Webhook 400 "bad signature" | `STRIPE_WEBHOOK_SECRET` mismatches the endpoint in Stripe dashboard |
| Payment succeeds but event stays unpaid | Webhook isn't reaching the backend — check Stripe → Webhooks → endpoint logs |
| Bypass code rejected | Code casing or whitespace — env var is parsed case-insensitively, but no spaces |
