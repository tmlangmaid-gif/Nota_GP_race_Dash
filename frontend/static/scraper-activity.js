const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const EVENT_ID = parseInt(params.get("event"), 10);
if (!EVENT_ID) {
  alert("No event id in URL.");
  location.href = "/";
}

const REFRESH_MS = 3000;

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

async function refresh() {
  let event_, rows;
  try {
    [event_, rows] = await Promise.all([
      API.getEvent(EVENT_ID),
      API.scraperLogs(EVENT_ID, 200),
    ]);
  } catch (err) {
    if (err.status === 404) {
      alert("This event no longer exists, or you don't have access.");
      location.replace("/");
    }
    return;
  }
  $("#event-name").textContent = event_.name;
  $("#back-link").href = `/dashboard?event=${EVENT_ID}`;

  const pill = $("#status-pill");
  if (event_.is_tracking) {
    pill.className = "tag live";
    pill.textContent = "LIVE";
  } else {
    pill.className = "tag idle";
    pill.textContent = "idle";
  }

  const tbody = document.querySelector("#scraper-activity-table tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted">No activity yet — the scraper hasn't run for this event.</td></tr>`;
    return;
  }

  const wrap = document.getElementById("scraper-activity-wrap");
  const savedScroll = wrap ? wrap.scrollTop : 0;
  tbody.innerHTML = rows.map((r) => {
    const t = new Date(r.ts);
    const time = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const levelColor = r.level === "error" ? "var(--bad)" :
                       r.level === "warn"  ? "var(--warn)" :
                       "var(--accent-2)";
    return `
      <tr>
        <td style="color: var(--muted); font-variant-numeric: tabular-nums;">${time}</td>
        <td style="color: ${levelColor}; text-transform: uppercase; font-weight: 600;">${escapeHtml(r.level)}</td>
        <td>${escapeHtml(r.message)}</td>
      </tr>`;
  }).join("");
  if (wrap && savedScroll > 0) wrap.scrollTop = savedScroll;
}

(async () => {
  const me = await Auth.requireAuth();
  await renderUserBar(me);
  await refresh();
  setInterval(() => refresh().catch(() => {}), REFRESH_MS);
})();
