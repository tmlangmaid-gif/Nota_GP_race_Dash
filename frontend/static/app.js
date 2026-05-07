const $ = (sel) => document.querySelector(sel);

let currentUser = null;

async function refresh() {
  const events = await API.listEvents();
  const list = $("#events-list");
  list.innerHTML = "";
  $("#events-empty").style.display = events.length ? "none" : "block";
  for (const ev of events) {
    const li = document.createElement("li");
    const status = ev.is_tracking ? '<span class="tag live">LIVE</span>' : '<span class="tag idle">idle</span>';
    const role = ev.role || "owner";
    const roleBadge = role === "owner"
      ? '<span class="tag" style="background:rgba(255,210,74,0.10);color:var(--us);border-color:var(--us)">owner</span>'
      : `<span class="tag">${role}</span>`;
    const publicBadge = ev.is_public
      ? '<span class="tag" style="background:rgba(102,209,138,0.10);color:var(--accent-2);border-color:var(--accent-2)">public</span>'
      : "";
    const isOwner = role === "owner";
    li.innerHTML = `
      <div>
        <div><strong>${escapeHtml(ev.name)}</strong> ${status} ${roleBadge} ${publicBadge}</div>
        <div class="muted" style="font-size:12px">
          ${ev.natsoft_url ? escapeHtml(ev.natsoft_url) : "<em>no URL set</em>"}
          ${ev.our_vehicle_number ? ` • our car: <strong>#${escapeHtml(ev.our_vehicle_number)}</strong>` : ""}
        </div>
      </div>
      <div class="right row">
        <a href="/dashboard?event=${ev.id}"><button class="primary">Open dashboard</button></a>
        ${isOwner ? `<button data-act="delete" data-id="${ev.id}" class="danger">Delete</button>` : ""}
      </div>
    `;
    list.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

document.addEventListener("submit", async (e) => {
  if (e.target.id !== "new-event-form") return;
  e.preventDefault();
  const name = $("#event-name").value.trim();
  const natsoft_url = $("#natsoft-url").value.trim() || null;
  if (!name) return;
  try {
    await API.createEvent({ name, natsoft_url });
    $("#event-name").value = "";
    $("#natsoft-url").value = "";
    await refresh();
  } catch (err) {
    alert("Failed to create event: " + err.message);
  }
});

// ---------------------------------------------------------------------------
// Meeting picker modal
// ---------------------------------------------------------------------------

const MeetingPicker = (function () {
  let _meetings = [];

  function open() {
    document.getElementById("meeting-picker-modal").style.display = "flex";
    refresh();
  }
  function close() {
    document.getElementById("meeting-picker-modal").style.display = "none";
  }

  async function refresh() {
    const status = document.getElementById("meeting-picker-status");
    const list = document.getElementById("meeting-picker-list");
    const discipline = parseInt(document.getElementById("meeting-discipline").value, 10);
    status.style.color = "var(--muted)";
    status.textContent = "Loading meetings from Natsoft… (~10s)";
    list.innerHTML = `<div class="muted" style="padding: 14px;">Fetching the meeting list. This launches a headless browser on the server, so the first request takes ~10 seconds.</div>`;
    try {
      _meetings = await API.natsoftMeetings(discipline);
      status.textContent = `${_meetings.length} meetings`;
      render();
    } catch (err) {
      status.style.color = "var(--bad)";
      status.textContent = err.message;
      list.innerHTML = `<div class="muted" style="padding: 14px; color: var(--bad);">Couldn't load: ${escapeHtml(err.message)}</div>`;
    }
  }

  function render() {
    const list = document.getElementById("meeting-picker-list");
    const liveOnly = document.getElementById("meeting-live-only").checked;
    const visible = liveOnly ? _meetings.filter((m) => m.has_live) : _meetings;
    if (!visible.length) {
      list.innerHTML = `<div class="muted" style="padding: 14px;">No ${liveOnly ? "live" : ""} meetings right now. ${liveOnly ? "Untick \"Live now only\" to see recent meetings." : ""}</div>`;
      return;
    }
    list.innerHTML = visible.map((m) => `
      <div class="member-row" style="padding: 8px 12px; cursor: ${m.has_live ? "pointer" : "default"};"
           data-act="pick-meeting" data-discipline="${document.getElementById("meeting-discipline").value}"
           data-slot="${m.slot}" data-name="${escapeHtml(m.name)}">
        <div style="grid-column: 1 / -1; display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap;">
          <strong style="font-size: 14px;">${escapeHtml(m.name)}</strong>
          ${m.has_live ? '<span class="tag live">LIVE</span>' : '<span class="tag idle">past</span>'}
          <span class="muted" style="font-size: 12px;">${escapeHtml(m.date)} • ${escapeHtml(m.track)}</span>
        </div>
      </div>
    `).join("");
  }

  return { open, close, refresh, render };
})();

document.addEventListener("change", (e) => {
  if (e.target.id === "meeting-discipline") MeetingPicker.refresh();
  if (e.target.id === "meeting-live-only") MeetingPicker.render();
});

document.addEventListener("click", async (e) => {
  if (e.target.id === "find-meeting-btn") {
    e.preventDefault();
    MeetingPicker.open();
    return;
  }
  if (e.target.id === "meeting-picker-close" || e.target.id === "meeting-picker-modal") {
    MeetingPicker.close();
    return;
  }

  const pick = e.target.closest('[data-act="pick-meeting"]');
  if (pick) {
    e.preventDefault();
    e.stopPropagation();
    const discipline = parseInt(pick.dataset.discipline, 10);
    const slot = parseInt(pick.dataset.slot, 10);
    const name = pick.dataset.name;
    const status = document.getElementById("meeting-picker-status");
    status.style.color = "var(--muted)";
    status.textContent = `Resolving "${name}"…`;
    try {
      const res = await API.natsoftResolve({ discipline, slot });
      document.getElementById("natsoft-url").value = res.url;
      // Pre-fill the event name with the meeting name as a sensible default
      const nameInp = document.getElementById("event-name");
      if (!nameInp.value.trim()) nameInp.value = name;
      MeetingPicker.close();
    } catch (err) {
      status.style.color = "var(--bad)";
      status.textContent = err.message;
    }
    return;
  }

  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "delete") {
    if (!confirm("Delete this event? All laps will be removed.")) return;
    try {
      await API.deleteEvent(btn.dataset.id);
      await refresh();
    } catch (err) {
      alert("Delete failed: " + err.message);
    }
  }
});

(async () => {
  currentUser = await Auth.requireAuth();
  await renderUserBar(currentUser);
  refresh().catch((err) => alert("Failed to load events: " + err.message));
})();
