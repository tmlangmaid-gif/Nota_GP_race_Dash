// Admin panel. Server-side gate: every endpoint behind /api/admin/* requires
// the caller's email to be in the ADMIN_EMAILS env var. The page does its own
// soft check up front (Auth.me().is_admin) and shows an "access denied" panel
// rather than the admin UI for non-admins — but the real enforcement is in
// the API.

(function () {
  const $ = (sel) => document.querySelector(sel);

  // Add small-tag versions of the admin endpoints to the global API helper.
  Object.assign(API, {
    adminListUsers:        ()       => api(`/api/admin/users`),
    adminDeleteUser:       (id)     => api(`/api/admin/users/${id}`, { method: "DELETE" }),
    adminListEvents:       ()       => api(`/api/admin/events`),
    adminSetEventPaid:     (id, p)  => api(`/api/admin/events/${id}/paid`, { method: "PATCH", body: { is_paid: p } }),
    adminDeleteEvent:      (id)     => api(`/api/admin/events/${id}`, { method: "DELETE" }),
    adminListBypassCodes:  ()       => api(`/api/admin/bypass_codes`),
    adminCreateBypassCode: (body)   => api(`/api/admin/bypass_codes`, { method: "POST", body }),
    adminDeleteBypassCode: (id)     => api(`/api/admin/bypass_codes/${id}`, { method: "DELETE" }),
  });

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function fmtDate(s) {
    if (!s) return "—";
    try {
      const d = new Date(s);
      return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch { return s; }
  }

  // ---- Tabs ----
  document.querySelectorAll(".admin-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".admin-tabs button").forEach((b) => b.classList.toggle("active", b === btn));
      const tab = btn.dataset.tab;
      document.querySelectorAll(".admin-section").forEach((s) => {
        s.classList.toggle("active", s.id === `tab-${tab}`);
      });
    });
  });

  // ---- Users ----
  async function refreshUsers() {
    let rows;
    try { rows = await API.adminListUsers(); }
    catch (err) { alert("Failed to load users: " + err.message); return; }
    $("#users-count").textContent = `${rows.length} user${rows.length === 1 ? "" : "s"}`;
    $("#users-tbody").innerHTML = rows.map((u) => `
      <tr>
        <td>${u.id}</td>
        <td>${escapeHtml(u.email)} ${u.is_admin ? '<span class="tag" style="background:rgba(255,210,74,0.15);color:var(--us);border-color:var(--us);font-size:10px;padding:1px 5px;">admin</span>' : ""}</td>
        <td class="small">${fmtDate(u.created_at)}</td>
        <td class="num">${u.event_count}</td>
        <td class="num">${u.membership_count}</td>
        <td class="admin-actions">
          ${u.is_admin ? "" : `<button class="danger" data-act="del-user" data-id="${u.id}" data-email="${escapeHtml(u.email)}">Delete</button>`}
        </td>
      </tr>
    `).join("");
  }

  // ---- Events ----
  async function refreshEvents() {
    let rows;
    try { rows = await API.adminListEvents(); }
    catch (err) { alert("Failed to load events: " + err.message); return; }
    $("#events-count").textContent = `${rows.length} event${rows.length === 1 ? "" : "s"}`;
    $("#events-tbody").innerHTML = rows.map((e) => {
      const trackingTag = e.is_tracking
        ? '<span class="tag live">LIVE</span>'
        : '<span class="tag idle">idle</span>';
      const paidTag = e.is_paid
        ? '<span class="tag" style="background:rgba(102,209,138,0.10);color:var(--accent-2);border-color:var(--accent-2)">paid</span>'
        : '<span class="tag" style="background:rgba(255,104,104,0.10);color:var(--bad);border-color:var(--bad)">unpaid</span>';
      const publicMark = e.is_public ? ' <span class="small">(public)</span>' : "";
      return `
        <tr>
          <td>${e.id}</td>
          <td><strong>${escapeHtml(e.name)}</strong>${publicMark}</td>
          <td class="small">${escapeHtml(e.owner_email)}</td>
          <td class="small">${fmtDate(e.created_at)}</td>
          <td>${trackingTag}</td>
          <td>${paidTag}</td>
          <td class="num">${e.member_count}</td>
          <td class="admin-actions">
            <button data-act="toggle-paid" data-id="${e.id}" data-current="${e.is_paid}">${e.is_paid ? "Mark unpaid" : "Mark paid"}</button>
            <button class="danger" data-act="del-event" data-id="${e.id}" data-name="${escapeHtml(e.name)}">Delete</button>
          </td>
        </tr>
      `;
    }).join("");
  }

  // ---- Bypass codes ----
  async function refreshCodes() {
    let rows;
    try { rows = await API.adminListBypassCodes(); }
    catch (err) { alert("Failed to load bypass codes: " + err.message); return; }
    $("#codes-tbody").innerHTML = rows.length ? rows.map((c) => `
      <tr>
        <td><strong>${escapeHtml(c.code)}</strong></td>
        <td>${escapeHtml(c.description || "—")}</td>
        <td class="small">${fmtDate(c.created_at)}</td>
        <td class="admin-actions">
          <button class="danger" data-act="del-code" data-id="${c.id}" data-code="${escapeHtml(c.code)}">Delete</button>
        </td>
      </tr>
    `).join("") : `<tr><td colspan="4" class="small">No DB-managed codes yet. Add one above, or set <code>STRIPE_BYPASS_CODES</code> on the server.</td></tr>`;
  }

  // ---- Click handler (delegated) ----
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === "del-user") {
      if (!confirm(`Delete user ${btn.dataset.email}? This wipes every event they own and all their data. This can't be undone.`)) return;
      try { await API.adminDeleteUser(btn.dataset.id); await refreshUsers(); await refreshEvents(); }
      catch (err) { alert("Delete failed: " + err.message); }
    }

    if (act === "toggle-paid") {
      const becomePaid = btn.dataset.current !== "true";
      try { await API.adminSetEventPaid(btn.dataset.id, becomePaid); await refreshEvents(); }
      catch (err) { alert("Update failed: " + err.message); }
    }

    if (act === "del-event") {
      if (!confirm(`Delete event "${btn.dataset.name}"? All laps, drivers, and memberships go with it. Can't be undone.`)) return;
      try { await API.adminDeleteEvent(btn.dataset.id); await refreshEvents(); await refreshUsers(); }
      catch (err) { alert("Delete failed: " + err.message); }
    }

    if (act === "del-code") {
      if (!confirm(`Delete bypass code "${btn.dataset.code}"? Anyone who hadn't redeemed it yet will see "code not valid".`)) return;
      try { await API.adminDeleteBypassCode(btn.dataset.id); await refreshCodes(); }
      catch (err) { alert("Delete failed: " + err.message); }
    }
  });

  // ---- Add bypass code form ----
  document.getElementById("add-code-btn").addEventListener("click", async () => {
    const codeInput = document.getElementById("new-code");
    const descInput = document.getElementById("new-code-desc");
    const msg = document.getElementById("codes-msg");
    const code = codeInput.value.trim();
    if (!code) {
      msg.style.color = "var(--bad)";
      msg.textContent = "Enter a code first.";
      return;
    }
    msg.style.color = "var(--muted)";
    msg.textContent = "Saving…";
    try {
      await API.adminCreateBypassCode({ code, description: descInput.value.trim() || null });
      codeInput.value = "";
      descInput.value = "";
      msg.style.color = "var(--accent-2)";
      msg.textContent = `Added "${code}".`;
      await refreshCodes();
    } catch (err) {
      msg.style.color = "var(--bad)";
      msg.textContent = err.message;
    }
  });

  // ---- Boot ----
  (async () => {
    const me = await Auth.requireAuth();
    await renderUserBar(me);
    if (!me.is_admin) {
      document.getElementById("access-denied").style.display = "block";
      return;
    }
    document.getElementById("admin-content").style.display = "block";
    await Promise.all([refreshUsers(), refreshEvents(), refreshCodes()]);
  })();
})();
