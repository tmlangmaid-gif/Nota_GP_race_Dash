// Paywall modal — shows 10 seconds after the dashboard has finished loading
// the event, but only if `event.is_paid` is false. Hard block: backdrop covers
// the dashboard and can't be dismissed without paying or entering a bypass code.
//
// API surface (window.Paywall):
//   armPaywallTimer(event)   -> start the 10-second countdown after first load
//   reloadEvent()            -> re-fetch and hide modal if event is now paid
//   handleSuccessReturn()    -> read ?paid=1 from URL on load, show success toast
//
// Sharing: only the OWNER sees the paywall. Non-owners viewing a shared event
// rely on the owner having paid; if the event is unpaid, members get the
// "owner needs to pay" panel (same modal, no checkout button).

(function () {
  let timerId = null;
  let modalEl = null;
  let currentEvent = null;
  let armed = false;
  let suppressArm = false;     // set after a successful Stripe return — webhook
                               // is usually <1s away, the next tick will hide
                               // the modal naturally

  function isOwner(ev) {
    return ev && ev.role === "owner";
  }

  function buildModal() {
    if (modalEl) return modalEl;
    const wrap = document.createElement("div");
    wrap.id = "paywall-modal";
    wrap.className = "modal-backdrop";
    wrap.style.display = "none";
    wrap.innerHTML = `
      <div class="modal" style="max-width: 520px;">
        <h2 style="margin-top:0;">Unlock this event</h2>
        <div id="paywall-owner-body" style="display:none">
          <p style="color: var(--muted); font-size: 14px;">
            Race Dash is <strong>$20 AUD per event</strong>.
            One-off payment — covers the whole race weekend, for you and everyone
            you've shared this event with.
          </p>
          <button id="paywall-pay-btn" class="primary" style="width:100%; padding:12px; font-size:15px; margin-top: 6px;">
            Pay $20 AUD with card
          </button>
          <div style="margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border);">
            <div style="font-size: 13px; color: var(--muted); margin-bottom: 6px;">
              Have a code? Enter it below. (Stripe-issued promo codes go on the payment page; codes here unlock the event for free.)
            </div>
            <div class="row">
              <input type="text" id="paywall-code-input" placeholder="UNLOCK CODE" style="flex:1; text-transform: uppercase;" autocomplete="off" />
              <button id="paywall-code-btn">Apply</button>
            </div>
            <div id="paywall-code-msg" class="muted" style="font-size: 12px; min-height: 1em; margin-top: 4px;"></div>
          </div>
        </div>
        <div id="paywall-shared-body" style="display:none">
          <p style="color: var(--muted); font-size: 14px;">
            This event hasn't been paid for yet. The event owner needs to unlock
            it before you can see live laps. Once they do, you'll have access
            automatically.
          </p>
          <button id="paywall-recheck-btn" style="width:100%; padding:10px;">
            Check again
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    modalEl = wrap;

    document.getElementById("paywall-pay-btn").addEventListener("click", onPayClick);
    document.getElementById("paywall-code-btn").addEventListener("click", onApplyCode);
    document.getElementById("paywall-code-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") onApplyCode();
    });
    document.getElementById("paywall-recheck-btn").addEventListener("click", reloadEvent);

    return wrap;
  }

  function show(ev) {
    currentEvent = ev;
    const m = buildModal();
    document.getElementById("paywall-owner-body").style.display = isOwner(ev) ? "block" : "none";
    document.getElementById("paywall-shared-body").style.display = isOwner(ev) ? "none" : "block";
    m.style.display = "flex";
  }

  function hide() {
    if (modalEl) modalEl.style.display = "none";
  }

  async function onPayClick() {
    const btn = document.getElementById("paywall-pay-btn");
    btn.disabled = true;
    btn.textContent = "Opening secure checkout…";
    try {
      const out = await API.checkout(currentEvent.id);
      // Stripe Checkout takes over from here. On success they bounce back to
      // the success_url we set server-side (?paid=1).
      window.location.href = out.url;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Pay $20 AUD with card";
      alert("Couldn't start checkout: " + (err.message || err));
    }
  }

  async function onApplyCode() {
    const input = document.getElementById("paywall-code-input");
    const msg = document.getElementById("paywall-code-msg");
    const btn = document.getElementById("paywall-code-btn");
    const code = (input.value || "").trim();
    if (!code) { msg.textContent = "Enter a code first."; return; }
    btn.disabled = true;
    msg.style.color = "var(--muted)";
    msg.textContent = "Checking…";
    try {
      const updated = await API.applyCode(currentEvent.id, code);
      msg.style.color = "var(--good, #2ecc71)";
      msg.textContent = "Unlocked!";
      currentEvent = updated;
      setTimeout(() => {
        hide();
        // Refresh event data so the rest of the dashboard sees is_paid:true.
        if (window.Paywall && typeof window.Paywall.onUnlocked === "function") {
          window.Paywall.onUnlocked(updated);
        }
      }, 600);
    } catch (err) {
      msg.style.color = "var(--bad, #e74c3c)";
      msg.textContent = "That code isn't valid.";
    } finally {
      btn.disabled = false;
    }
  }

  async function reloadEvent() {
    if (!currentEvent) return;
    try {
      const ev = await API.getEvent(currentEvent.id);
      currentEvent = ev;
      if (ev.is_paid) {
        hide();
        if (window.Paywall && typeof window.Paywall.onUnlocked === "function") {
          window.Paywall.onUnlocked(ev);
        }
      }
    } catch (_) { /* ignore — they'll click again */ }
  }

  // Public: arm the 10-second timer once the dashboard has its event loaded.
  // Call this AFTER the initial loadAll() so we know is_paid for sure.
  function armPaywallTimer(event) {
    if (armed) return;
    armed = true;
    currentEvent = event;
    if (event.is_paid) return;     // already paid — nothing to do
    if (suppressArm) return;        // just returned from successful checkout
    if (timerId) clearTimeout(timerId);
    timerId = setTimeout(() => show(event), 10_000);
  }

  // If a tick re-fetches the event and finds it paid (e.g. webhook fired while
  // the modal was waiting), cancel everything.
  function noteEventUpdate(event) {
    currentEvent = event;
    if (event.is_paid) {
      if (timerId) { clearTimeout(timerId); timerId = null; }
      hide();
    }
  }

  // Read ?paid=1 / ?paid=cancelled from the URL on page load and surface a
  // friendly toast. Stripe rewrites the query string when redirecting back.
  function handleSuccessReturn() {
    const p = new URLSearchParams(location.search);
    const paid = p.get("paid");
    if (!paid) return;
    // Strip the paid/session_id params from the URL bar so a refresh doesn't
    // re-show the toast.
    p.delete("paid"); p.delete("session_id");
    const cleanQs = p.toString();
    history.replaceState(null, "", location.pathname + (cleanQs ? "?" + cleanQs : ""));
    if (paid === "1") {
      suppressArm = true;
      toast("Payment received — you're in.", "good");
    } else if (paid === "cancelled") {
      toast("Checkout cancelled. You can try again any time.", "warn");
    }
  }

  function toast(text, kind) {
    const el = document.createElement("div");
    el.className = "paywall-toast " + (kind || "");
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => { el.classList.add("show"); }, 10);
    setTimeout(() => { el.classList.remove("show"); }, 4000);
    setTimeout(() => { el.remove(); }, 4500);
  }

  window.Paywall = {
    armPaywallTimer,
    noteEventUpdate,
    handleSuccessReturn,
    onUnlocked: null,    // dashboard.js can override to trigger a full reload
  };
})();
