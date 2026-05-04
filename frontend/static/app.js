const $ = (sel) => document.querySelector(sel);

async function refresh() {
  const events = await API.listEvents();
  const list = $("#events-list");
  list.innerHTML = "";
  $("#events-empty").style.display = events.length ? "none" : "block";
  for (const ev of events) {
    const li = document.createElement("li");
    const status = ev.is_tracking ? '<span class="tag live">LIVE</span>' : '<span class="tag idle">idle</span>';
    li.innerHTML = `
      <div>
        <div><strong>${escapeHtml(ev.name)}</strong> ${status}</div>
        <div class="muted" style="font-size:12px">
          ${ev.natsoft_url ? escapeHtml(ev.natsoft_url) : "<em>no URL set</em>"}
          ${ev.our_vehicle_number ? ` • our car: <strong>#${escapeHtml(ev.our_vehicle_number)}</strong>` : ""}
        </div>
      </div>
      <div class="right row">
        <a href="/dashboard?event=${ev.id}"><button class="primary">Open dashboard</button></a>
        <button data-act="delete" data-id="${ev.id}" class="danger">Delete</button>
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

document.addEventListener("click", async (e) => {
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

refresh().catch((err) => alert("Failed to load events: " + err.message));
