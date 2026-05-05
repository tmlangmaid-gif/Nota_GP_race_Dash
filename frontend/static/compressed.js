// Compressed quick-view: per car, list each rostered driver's top 5 lap times.
// Auto-refreshes every 5s.

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const EVENT_ID = parseInt(params.get("event"), 10);
if (!EVENT_ID) {
  alert("No event id in URL.");
  location.href = "/";
}

const REFRESH_MS = 5000;
const FALLBACK_COLORS = [
  "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71",
  "#1abc9c", "#3498db", "#9b59b6", "#e91e63",
  "#ff5722", "#00bcd4", "#8bc34a", "#795548",
];

let event_ = null;
let drivers = [];
let laps = [];
let trackedCars = [];

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function hashColor(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
}

function driverColor(d) {
  return d.color || hashColor(d.name);
}

function renderCars() {
  const wrap = $("#cars");
  if (!trackedCars.length) {
    wrap.innerHTML = "";
    $("#empty").style.display = "block";
    return;
  }
  $("#empty").style.display = "none";

  // Build per-car driver groups.
  wrap.innerHTML = trackedCars.map((tc) => {
    const carDrivers = drivers.filter((d) => d.vehicle_number === tc.vehicle_number);
    const carLaps = laps.filter((l) => l.vehicle_number === tc.vehicle_number && !l.is_deleted);
    const lapsByDriver = {};
    for (const l of carLaps) {
      if (l.driver_id != null) (lapsByDriver[l.driver_id] ||= []).push(l);
    }

    const decorated = carDrivers.map((d) => {
      const dlaps = lapsByDriver[d.id] || [];
      const top5 = [...dlaps].sort((a, b) => a.lap_time_ms - b.lap_time_ms).slice(0, 5);
      return {
        d,
        total: dlaps.length,
        best: top5.length ? top5[0].lap_time_ms : null,
        top5,
      };
    }).sort((a, b) => {
      if (a.best == null && b.best == null) return a.d.name.localeCompare(b.d.name);
      if (a.best == null) return 1;
      if (b.best == null) return -1;
      return a.best - b.best;
    });

    const titleBits = [];
    if (tc.name) titleBits.push(escapeHtml(tc.name));
    titleBits.push(`#${escapeHtml(tc.vehicle_number)}`);
    const title = titleBits.join(" ");

    const driverRowsHTML = decorated.length === 0
      ? `<div class="muted" style="padding: 8px 0;">No drivers on this car yet.</div>`
      : decorated.map(({ d, total, best, top5 }) => {
          const chipsHTML = top5.length === 0
            ? `<span class="muted" style="font-size:13px">no laps yet</span>`
            : top5.map((l, i) => `
                <span class="top5-chip rank-${i + 1}" title="lap #${l.lap_number}">
                  <span class="rank">${i + 1}</span>${fmtLapMs(l.lap_time_ms)}
                </span>`).join("");
          return `
            <div class="compressed-driver">
              <div class="name">
                <span class="dot" style="background:${driverColor(d)}"></span>
                ${escapeHtml(d.name)}
              </div>
              <div class="stats">
                laps <strong>${total}</strong> &nbsp;·&nbsp; best <strong>${fmtLapMs(best)}</strong>
              </div>
              <div class="chips">${chipsHTML}</div>
            </div>`;
        }).join("");

    return `
      <section class="panel">
        <h2 style="margin: 0 0 4px; font-size: 16px; text-transform: none; letter-spacing: 0; color: var(--text);">
          ${title}
        </h2>
        ${tc.description ? `<div class="muted" style="font-size:12px; margin-bottom:8px; font-style: italic;">${escapeHtml(tc.description)}</div>` : ""}
        ${driverRowsHTML}
      </section>`;
  }).join("");
}

async function loadAll() {
  const [ev, drv, lp, tc] = await Promise.all([
    API.getEvent(EVENT_ID),
    API.listDrivers(EVENT_ID),
    API.listLaps(EVENT_ID),
    API.listTracked(EVENT_ID),
  ]);
  event_ = ev; drivers = drv; laps = lp; trackedCars = tc;
  $("#event-name").textContent = ev.name;
  $("#back-link").href = `/dashboard?event=${EVENT_ID}`;
  renderCars();
}

(async () => {
  const me = await Auth.requireAuth();
  await renderUserBar(me);
  try {
    await loadAll();
  } catch (err) {
    if (err.status === 404) {
      alert("This event no longer exists, or you don't have access.");
      location.replace("/");
      return;
    }
    alert("Failed to load: " + err.message);
    return;
  }
  setInterval(() => loadAll().catch(() => {}), REFRESH_MS);
})();
