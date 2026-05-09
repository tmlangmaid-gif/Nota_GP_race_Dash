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
    adminSetUserAdmin:     (id, p)  => api(`/api/admin/users/${id}/admin`, { method: "PATCH", body: { is_admin: p } }),
    adminDeleteUser:       (id)     => api(`/api/admin/users/${id}`, { method: "DELETE" }),
    adminListEvents:       ()       => api(`/api/admin/events`),
    adminSetEventPaid:     (id, p)  => api(`/api/admin/events/${id}/paid`, { method: "PATCH", body: { is_paid: p } }),
    adminDeleteEvent:      (id)     => api(`/api/admin/events/${id}`, { method: "DELETE" }),
    adminListBypassCodes:  ()       => api(`/api/admin/bypass_codes`),
    adminCreateBypassCode: (body)   => api(`/api/admin/bypass_codes`, { method: "POST", body }),
    adminDeleteBypassCode: (id)     => api(`/api/admin/bypass_codes/${id}`, { method: "DELETE" }),
    adminListAudit:        ()       => api(`/api/admin/audit?limit=200`),
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
    $("#users-tbody").innerHTML = rows.map((u) => {
      const adminTag = u.is_admin
        ? '<span class="tag" style="background:rgba(255,210,74,0.15);color:var(--us);border-color:var(--us);font-size:10px;padding:1px 5px;">admin</span>'
        : "";
      const adminBtn = u.is_admin
        ? `<button data-act="demote-user" data-id="${u.id}" data-email="${escapeHtml(u.email)}">Revoke admin</button>`
        : `<button data-act="promote-user" data-id="${u.id}" data-email="${escapeHtml(u.email)}">Make admin</button>`;
      return `
        <tr>
          <td>${u.id}</td>
          <td>${escapeHtml(u.email)} ${adminTag}</td>
          <td class="small">${fmtDate(u.created_at)}</td>
          <td class="num">${u.event_count}</td>
          <td class="num">${u.membership_count}</td>
          <td class="admin-actions">
            ${adminBtn}
            ${u.is_admin ? "" : `<button class="danger" data-act="del-user" data-id="${u.id}" data-email="${escapeHtml(u.email)}">Delete</button>`}
          </td>
        </tr>
      `;
    }).join("");
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
      try { await API.adminDeleteUser(btn.dataset.id); await refreshUsers(); await refreshEvents(); await refreshAudit(); }
      catch (err) { alert("Delete failed: " + err.message); }
    }

    if (act === "promote-user") {
      if (!confirm(`Grant admin access to ${btn.dataset.email}? They'll see the Admin button and be able to manage every user, event, and bypass code.`)) return;
      try { await API.adminSetUserAdmin(btn.dataset.id, true); await refreshUsers(); await refreshAudit(); }
      catch (err) { alert("Promote failed: " + err.message); }
    }

    if (act === "demote-user") {
      if (!confirm(`Revoke admin access from ${btn.dataset.email}?`)) return;
      try { await API.adminSetUserAdmin(btn.dataset.id, false); await refreshUsers(); await refreshAudit(); }
      catch (err) { alert("Demote failed: " + err.message); }
    }

    if (act === "toggle-paid") {
      const becomePaid = btn.dataset.current !== "true";
      try { await API.adminSetEventPaid(btn.dataset.id, becomePaid); await refreshEvents(); await refreshAudit(); }
      catch (err) { alert("Update failed: " + err.message); }
    }

    if (act === "del-event") {
      if (!confirm(`Delete event "${btn.dataset.name}"? All laps, drivers, and memberships go with it. Can't be undone.`)) return;
      try { await API.adminDeleteEvent(btn.dataset.id); await refreshEvents(); await refreshUsers(); await refreshAudit(); }
      catch (err) { alert("Delete failed: " + err.message); }
    }

    if (act === "del-code") {
      if (!confirm(`Delete bypass code "${btn.dataset.code}"? Anyone who hadn't redeemed it yet will see "code not valid".`)) return;
      try { await API.adminDeleteBypassCode(btn.dataset.id); await refreshCodes(); await refreshAudit(); }
      catch (err) { alert("Delete failed: " + err.message); }
    }
  });

  // ---- Audit log ----
  async function refreshAudit() {
    const tbody = document.getElementById("audit-tbody");
    if (!tbody) return;
    let rows;
    try { rows = await API.adminListAudit(); }
    catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted">Couldn't load: ${escapeHtml(err.message)}</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.length ? rows.map((r) => `
      <tr>
        <td class="small">${fmtDate(r.ts)}</td>
        <td>${escapeHtml(r.actor_email)}</td>
        <td><code>${escapeHtml(r.action)}</code></td>
        <td class="small">${escapeHtml(r.target_kind || "")}${r.target_id != null ? ` #${r.target_id}` : ""}</td>
        <td class="small">${escapeHtml(r.detail || "")}</td>
      </tr>
    `).join("") : `<tr><td colspan="5" class="muted">No admin actions recorded yet.</td></tr>`;
  }

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
      await refreshAudit();
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
    await Promise.all([refreshUsers(), refreshEvents(), refreshCodes(), refreshAudit()]);
  })();
})();
