// Competitors page: lists every car in this event with summary stats and an
// expandable detail panel (all laps + per-car chart). No driver allocation —
// drivers are concept tied to your tracked cars; competitors are everyone else.

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const EVENT_ID = parseInt(params.get("event"), 10);
if (!EVENT_ID) {
  alert("No event id in URL.");
  location.href = "/";
}

const REFRESH_MS = 5000;
const FALLBACK_COLORS = [
  "#4f9dff", "#66d18a", "#f0b13e", "#ff6868", "#b683ff",
  "#5ed0d0", "#ff9bd0", "#a8d957", "#7fb1ff", "#d39c5e",
];

let event_ = null;
let laps = [];
let trackedCars = [];
let filterMode = "all";   // "all" | "competitors" | "tracked"
let sortMode = "best";    // "best" | "laps" | "last" | "number"
const expandedCars = new Set();
const carCharts = new Map();   // vehicle_number -> Chart

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
function vehicleColor(v) { return hashColor("v:" + v); }
function tsMs(lap) { return lap.completed_at ? new Date(lap.completed_at).getTime() : null; }
function trackedSet() { return new Set(trackedCars.map((t) => t.vehicle_number)); }

function buildSummary() {
  const tracked = trackedSet();
  const byVehicle = {};
  for (const l of laps) {
    if (l.is_deleted) continue;
    (byVehicle[l.vehicle_number] ||= []).push(l);
  }
  const summary = Object.entries(byVehicle).map(([vehicle, vlaps]) => {
    vlaps.sort((a, b) => a.lap_number - b.lap_number);
    const times = vlaps.map((l) => l.lap_time_ms);
    const last = vlaps[vlaps.length - 1];
    return {
      vehicle,
      isTracked: tracked.has(vehicle),
      total: vlaps.length,
      best: Math.min(...times),
      lastTime: last.lap_time_ms,
      lastPos: last.position,
      laps: vlaps,
    };
  });
  // Filter
  let filtered = summary;
  if (filterMode === "competitors") filtered = summary.filter((c) => !c.isTracked);
  else if (filterMode === "tracked") filtered = summary.filter((c) => c.isTracked);
  // Sort
  filtered.sort((a, b) => {
    if (sortMode === "best") return a.best - b.best;
    if (sortMode === "laps") return b.total - a.total;
    if (sortMode === "last") return a.lastTime - b.lastTime;
    if (sortMode === "number") {
      const an = parseInt(a.vehicle, 10), bn = parseInt(b.vehicle, 10);
      if (!isNaN(an) && !isNaN(bn)) return an - bn;
      return a.vehicle.localeCompare(b.vehicle);
    }
    return 0;
  });
  return filtered;
}

function fmtLapMsLocal(ms) {
  if (ms == null) return "—";
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(3);
  return minutes > 0 ? `${minutes}:${seconds.padStart(6, "0")}` : seconds;
}

function renderCars() {
  const wrap = $("#car-cards");
  const cars = buildSummary();
  if (!cars.length) {
    wrap.innerHTML = "";
    $("#cars-empty").style.display = "block";
    // Tear down any open charts (no cars to show).
    for (const [, chart] of carCharts) chart.destroy();
    carCharts.clear();
    return;
  }
  $("#cars-empty").style.display = "none";

  // Destroy old charts before innerHTML swap (canvases will be detached).
  for (const [, chart] of carCharts) chart.destroy();
  carCharts.clear();

  wrap.innerHTML = cars.map((c) => {
    const top3 = [...c.laps].sort((a, b) => a.lap_time_ms - b.lap_time_ms).slice(0, 3);
    const isOpen = expandedCars.has(c.vehicle);
    const colour = c.isTracked ? "#ffd24a" : vehicleColor(c.vehicle);
    return `
      <details class="driver-card ${c.isTracked ? "fastest" : ""}" data-car="${escapeHtml(c.vehicle)}" ${isOpen ? "open" : ""}>
        <summary>
          <span class="driver-swatch" style="background:${colour}; cursor: default;" title="car colour"></span>
          <span class="driver-name"><strong>#${escapeHtml(c.vehicle)}</strong>${c.isTracked ? ' <span class="tag" style="font-size:10px;">us</span>' : ""}</span>
          <span class="driver-stat">total laps <strong style="font-size:14px; color: var(--text);">${c.total}</strong></span>
          <span class="driver-stat">best <strong>${fmtLapMsLocal(c.best)}</strong></span>
          <span class="driver-stat">last <strong>${fmtLapMsLocal(c.lastTime)}</strong> ${c.lastPos != null ? `(P${c.lastPos})` : ""}</span>
          <div class="top5-strip">
            ${top3.map((l, i) => `
              <span class="top5-chip rank-${i + 1}" title="lap #${l.lap_number}">
                <span class="rank">${i + 1}</span>${fmtLapMsLocal(l.lap_time_ms)}
              </span>`).join("")}
          </div>
        </summary>
        <div class="body">
          <div>
            <h3 style="margin:0 0 6px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em;">
              All laps (${c.total})
            </h3>
            <table>
              <thead><tr><th>Lap</th><th>Time</th><th>Pos</th></tr></thead>
              <tbody>
                ${[...c.laps].sort((a, b) => b.lap_number - a.lap_number).map((l) => `
                  <tr>
                    <td>${l.lap_number}</td>
                    <td>${fmtLapMsLocal(l.lap_time_ms)}</td>
                    <td>${l.position ?? "—"}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>
          <div>
            <h3 style="margin:0 0 6px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em;">
              Lap-time history
            </h3>
            <div class="driver-mini-chart-wrap">
              <canvas id="car-chart-${escapeHtml(c.vehicle)}"></canvas>
            </div>
          </div>
        </div>
      </details>
    `;
  }).join("");

  for (const v of expandedCars) {
    const car = cars.find((c) => c.vehicle === v);
    if (car) drawCarChart(car);
  }
}

function drawCarChart(car) {
  const canvas = document.getElementById(`car-chart-${car.vehicle}`);
  if (!canvas) return;
  // Drop outlier laps (likely pit laps) so the y-axis isn't distorted.
  // Keep filter behaviour identical to the dashboard view.
  const mult = event_ && Number(event_.outlier_multiplier);
  let plotted = car.laps;
  if (mult && mult > 0 && car.laps.length >= 5) {
    const sorted = car.laps.map((l) => l.lap_time_ms).slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const threshold = median * mult;
    plotted = car.laps.filter((l) => l.lap_time_ms <= threshold);
  }
  const data = plotted.map((l) => ({ x: l.lap_number, y: l.lap_time_ms / 1000, _lap: l }));
  const colour = car.isTracked ? "#ffd24a" : vehicleColor(car.vehicle);

  const chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { datasets: [{
      label: `#${car.vehicle}`,
      data,
      borderColor: colour,
      backgroundColor: colour,
      borderWidth: 2,
      pointRadius: 3,
      tension: 0.15,
    }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: { type: "linear", title: { display: true, text: "Lap #" }, ticks: { color: "#8b93a7" }, grid: { color: "#2a3140" } },
        y: { title: { display: true, text: "Lap time (s)" }, ticks: { color: "#8b93a7" }, grid: { color: "#2a3140" } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => items[0] ? `Lap ${items[0].parsed.x}` : "",
            label: (item) => {
              const lap = item.raw?._lap;
              const time = lap ? fmtLapMsLocal(lap.lap_time_ms) : `${item.parsed.y.toFixed(3)}s`;
              return `${item.dataset.label} — ${time}`;
            },
          },
        },
      },
    },
  });
  carCharts.set(car.vehicle, chart);
}

async function loadAll() {
  const [ev, lp, tc] = await Promise.all([
    API.getEvent(EVENT_ID),
    API.listLaps(EVENT_ID),
    API.listTracked(EVENT_ID),
  ]);
  event_ = ev; laps = lp; trackedCars = tc;
  $("#event-name").textContent = ev.name;
  $("#back-link").href = `/dashboard?event=${EVENT_ID}`;
  renderCars();
}

document.addEventListener("toggle", (e) => {
  const card = e.target;
  if (!card || !card.dataset || !("car" in card.dataset)) return;
  const v = card.dataset.car;
  if (card.open) {
    expandedCars.add(v);
    const cars = buildSummary();
    const car = cars.find((c) => c.vehicle === v);
    if (car) drawCarChart(car);
  } else {
    expandedCars.delete(v);
    const chart = carCharts.get(v);
    if (chart) { chart.destroy(); carCharts.delete(v); }
  }
}, true);

$("#filter").addEventListener("change", (e) => {
  filterMode = e.target.value;
  renderCars();
});
$("#sort").addEventListener("change", (e) => {
  sortMode = e.target.value;
  renderCars();
});

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
