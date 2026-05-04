const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const EVENT_ID = parseInt(params.get("event"), 10);
if (!EVENT_ID) {
  alert("No event id in URL. Go back to the home page and pick one.");
  location.href = "/";
}

const REFRESH_MS = 3000;
const MAX_TRACKED_SLOTS = 2;
const FAST_LAP_THRESHOLD_MS = 72_000;   // sub-1:12 laps are tinted red
const NOTE_SAVE_DEBOUNCE_MS = 700;

// 12 preset driver colours (Material-ish palette, distinct + race-friendly).
const PALETTE = [
  "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71",
  "#1abc9c", "#3498db", "#9b59b6", "#e91e63",
  "#ff5722", "#00bcd4", "#8bc34a", "#795548",
];

const FALLBACK_COLORS = PALETTE;
const US_COLOR = "#ffd24a";

let event_ = null;
let drivers = [];
let vehicles = [];
let laps = [];
let trackedCars = [];   // [{id, slot, vehicle_number, current_driver_id}]
let chartAllDrivers = null;
let chartAllCars = null;
let chartPosition = null;
let allCarsFilter = "tracked";
const driverMiniCharts = new Map();
const expandedDrivers = new Set();
let editingDriverId = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function driverColor(driver) {
  return driver.color || hashColor(driver.name);
}

function vehicleColor(v) {
  return hashColor("v:" + v);
}

function fmtTimeOfDay(ms) {
  if (ms == null) return "";
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function tsMs(lap) {
  return lap.completed_at ? new Date(lap.completed_at).getTime() : null;
}

function findDriver(id) {
  return drivers.find((d) => d.id === id) || null;
}

function colorForLapByDriver(lap) {
  if (!lap || !lap.driver_id) return US_COLOR;
  const d = findDriver(lap.driver_id);
  return d ? driverColor(d) : US_COLOR;
}

function driverNameForLap(lap) {
  if (!lap || !lap.driver_id) return null;
  const d = findDriver(lap.driver_id);
  return d ? d.name : null;
}

function trackedVehicles() {
  return new Set(trackedCars.map((t) => t.vehicle_number));
}

function isOurCar(vehicle) {
  return trackedVehicles().has(vehicle);
}

// ---------------------------------------------------------------------------
// Header / controls
// ---------------------------------------------------------------------------

function renderHeader() {
  $("#event-name").textContent = event_.name;
  const tag = $("#status-tag");
  if (event_.is_tracking) {
    tag.className = "tag live";
    tag.textContent = "LIVE";
  } else {
    tag.className = "tag idle";
    tag.textContent = "idle";
  }
  $("#track-btn").textContent = event_.is_tracking ? "Stop tracking" : "Start tracking";
}

// ---------------------------------------------------------------------------
// Tracked cars panel
// ---------------------------------------------------------------------------

function trackedSlotHTML(slot, tc) {
  const vehicleOpts = ['<option value="">— pick a car —</option>']
    .concat(vehicles.map((v) =>
      `<option value="${escapeHtml(v)}" ${tc && v === tc.vehicle_number ? "selected" : ""}>#${escapeHtml(v)}</option>`
    )).join("");

  const driverOpts = ['<option value="">— no current driver —</option>']
    .concat(drivers.map((d) =>
      `<option value="${d.id}" ${tc && d.id === tc.current_driver_id ? "selected" : ""}>${escapeHtml(d.name)}</option>`
    )).join("");

  if (!tc) {
    if (vehicles.length === 0) {
      return `
        <div class="tracked-slot empty">
          <label>Slot ${slot}</label>
          <div class="muted" style="grid-column: 2 / -1; font-size: 12px;">
            ${event_.is_tracking
              ? "Waiting for the first laps to come in — cars appear here as soon as the live timing reports any lap. Give it ~3 seconds for demo, longer for a real event."
              : "Click <strong>Start tracking</strong> at the top right. Cars will appear here once the live timing reports any lap."}
          </div>
        </div>`;
    }
    return `
      <div class="tracked-slot empty">
        <label>Slot ${slot}</label>
        <select class="tracked-vehicle" data-slot="${slot}">${vehicleOpts}</select>
        <label>Current driver</label>
        <select disabled><option>add a car first</option></select>
        <span></span>
      </div>`;
  }
  // Compute laps-on-current-tyres (laps in the latest stint).
  const carLaps = laps.filter((l) => l.vehicle_number === tc.vehicle_number && !l.is_deleted);
  const lapsOnTyres = carLaps.filter((l) => (l.tyre_stint || 1) === (tc.tyre_stint || 1)).length;
  return `
    <div class="tracked-slot">
      <label>Slot ${slot}</label>
      <select class="tracked-vehicle" data-tracked="${tc.id}">${vehicleOpts}</select>
      <label>Current driver</label>
      <select class="tracked-driver" data-tracked="${tc.id}">${driverOpts}</select>
      <button class="icon-btn" data-act="remove-tracked" data-tracked="${tc.id}" title="remove">×</button>
      <div style="grid-column: 1 / -1; display:flex; gap:10px; align-items:center; padding-top: 6px; border-top: 1px dashed var(--border); margin-top: 4px;">
        <span class="driver-stat">Tyres:
          <span class="stint-badge s${((tc.tyre_stint || 1) - 1) % 5 + 1}">stint ${tc.tyre_stint || 1}</span>
          <strong>${lapsOnTyres}</strong> lap${lapsOnTyres === 1 ? "" : "s"} on
        </span>
        <button class="icon-btn" data-act="tyre-change" data-tracked="${tc.id}">Tyre change</button>
      </div>
    </div>`;
}

function renderTrackedCars() {
  const wrap = $("#tracked-cars");
  const bySlot = new Map(trackedCars.map((t) => [t.slot, t]));
  const html = [];
  for (let s = 1; s <= MAX_TRACKED_SLOTS; s++) {
    html.push(trackedSlotHTML(s, bySlot.get(s) || null));
  }
  wrap.innerHTML = html.join("");
}

// ---------------------------------------------------------------------------
// Driver cards
// ---------------------------------------------------------------------------

function lapsByDriverId(driverId) {
  return laps.filter((l) => l.driver_id === driverId)
             .sort((a, b) => a.lap_number - b.lap_number);
}

function renderDriverCards() {
  const wrap = $("#drivers-cards");

  // Destroy any existing mini charts BEFORE replacing innerHTML — otherwise
  // their canvases get detached and Chart.js renders into a phantom element.
  for (const [, chart] of driverMiniCharts) chart.destroy();
  driverMiniCharts.clear();

  if (!drivers.length) {
    wrap.innerHTML = "";
    $("#drivers-empty").style.display = "block";
    return;
  }
  $("#drivers-empty").style.display = "none";

  const decorated = drivers.map((d) => {
    const dlaps = lapsByDriverId(d.id);
    const times = dlaps.map((l) => l.lap_time_ms);
    return {
      d, dlaps,
      best: times.length ? Math.min(...times) : null,
      total: dlaps.length,
    };
  }).sort((a, b) => {
    if (a.best == null && b.best == null) return a.d.name.localeCompare(b.d.name);
    if (a.best == null) return 1;
    if (b.best == null) return -1;
    return a.best - b.best;
  });

  // Identify the fastest driver (the first decorated entry that has any lap).
  const fastestId = decorated.find((x) => x.best != null)?.d.id ?? null;

  wrap.innerHTML = decorated.map(({ d, dlaps, best, total }) => {
    const color = driverColor(d);
    const top5 = [...dlaps].sort((a, b) => a.lap_time_ms - b.lap_time_ms).slice(0, 5);
    const isOpen = expandedDrivers.has(d.id);
    const isEditing = editingDriverId === d.id;
    const isFastest = d.id === fastestId;

    const top5Strip = top5.length === 0
      ? `<span class="muted" style="font-size:12px">no laps yet</span>`
      : top5.map((l, i) => `
          <span class="top5-chip rank-${i + 1}" title="lap #${l.lap_number}">
            <span class="rank">${i + 1}</span>${fmtLapMs(l.lap_time_ms)}
          </span>`).join("");

    return `
      <details class="driver-card ${isFastest ? "fastest" : ""}" data-driver="${d.id}" ${isOpen ? "open" : ""}>
        <summary>
          <span class="driver-swatch" data-act="pick-color" data-driver="${d.id}"
                style="background:${color}" title="Click to change colour"></span>

          <span class="driver-name">
            ${isEditing
              ? `<input type="text" data-act="rename-input" data-driver="${d.id}" value="${escapeHtml(d.name)}" />`
              : escapeHtml(d.name)}
          </span>

          <span class="driver-stat">laps <strong>${total}</strong></span>
          <span class="driver-stat">best <strong>${fmtLapMs(best)}</strong></span>

          <span class="driver-actions">
            ${isEditing
              ? `<button data-act="rename-save" data-driver="${d.id}" class="primary">Save</button>
                 <button data-act="rename-cancel" data-driver="${d.id}">Cancel</button>`
              : `<button class="icon-btn" data-act="rename" data-driver="${d.id}" title="rename">Rename</button>`}
            <button class="icon-btn" data-act="delete-driver" data-driver="${d.id}" title="remove">×</button>
          </span>

          <div class="top5-strip">${top5Strip}</div>
        </summary>

        <div class="body">
          <div>
            <h3 style="margin:0 0 6px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em;">
              All laps (${dlaps.length})
            </h3>
            ${dlaps.length === 0
              ? `<div class="muted">No laps assigned to this driver yet.</div>`
              : `<table>
                   <thead><tr><th>Lap</th><th>Time</th></tr></thead>
                   <tbody>
                     ${dlaps.map((l) => `<tr><td>${l.lap_number}</td><td>${fmtLapMs(l.lap_time_ms)}</td></tr>`).join("")}
                   </tbody>
                 </table>`}
          </div>
          <div>
            <h3 style="margin:0 0 6px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em;">
              Lap-time history
            </h3>
            <div class="driver-mini-chart-wrap">
              <canvas id="driver-mini-${d.id}"></canvas>
            </div>
          </div>
        </div>
      </details>
    `;
  }).join("");

  for (const id of expandedDrivers) {
    const driver = drivers.find((d) => d.id === id);
    if (driver) drawDriverMiniChart(driver);
  }
}

function drawDriverMiniChart(driver) {
  const canvas = document.getElementById(`driver-mini-${driver.id}`);
  if (!canvas) return;
  const dlaps = lapsByDriverId(driver.id);
  const data = dlaps.map((l) => ({ x: l.lap_number, y: l.lap_time_ms / 1000, _lap: l }));
  const color = driverColor(driver);

  // Mini charts are always created fresh after the parent card re-renders,
  // because we destroyed all mini charts in renderDriverCards().
  const chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      datasets: [{
        label: driver.name,
        data,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        pointRadius: 3,
        tension: 0.15,
      }],
    },
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
              const time = lap ? fmtLapMs(lap.lap_time_ms) : `${item.parsed.y.toFixed(3)}s`;
              return `${item.dataset.label} — ${time}`;
            },
          },
        },
      },
    },
  });
  driverMiniCharts.set(driver.id, chart);
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function buildAllDriversDatasets() {
  return drivers.map((d) => {
    const dlaps = lapsByDriverId(d.id);
    return {
      label: d.name,
      data: dlaps.map((l) => ({ x: l.lap_number, y: l.lap_time_ms / 1000, _lap: l })),
      borderColor: driverColor(d),
      backgroundColor: driverColor(d),
      borderWidth: 2,
      pointRadius: 3,
      tension: 0.15,
    };
  });
}

function renderAllDriversChart() {
  const datasets = buildAllDriversDatasets();
  if (chartAllDrivers) {
    chartAllDrivers.data.datasets = datasets;
    chartAllDrivers.update("none");
    return;
  }
  chartAllDrivers = new Chart($("#chart-all-drivers").getContext("2d"), {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: { type: "linear", title: { display: true, text: "Car lap #" }, ticks: { color: "#8b93a7" }, grid: { color: "#2a3140" } },
        y: { title: { display: true, text: "Lap time (s)" }, ticks: { color: "#8b93a7" }, grid: { color: "#2a3140" } },
      },
      plugins: {
        legend: { labels: { color: "#e6e8ee" } },
        tooltip: {
          callbacks: {
            title: (items) => items[0] ? `Lap ${items[0].parsed.x}` : "",
            label: (item) => {
              const lap = item.raw?._lap;
              const time = lap ? fmtLapMs(lap.lap_time_ms) : `${item.parsed.y.toFixed(3)}s`;
              return `${item.dataset.label} — ${time}`;
            },
          },
        },
      },
    },
  });
}

function visibleVehiclesForAllCars() {
  const tracked = trackedVehicles();
  if (allCarsFilter === "tracked") return tracked;
  if (allCarsFilter === "all") return new Set(vehicles);
  // top5 = tracked + the 5 fastest competitors (by best lap so far).
  const bestByVehicle = {};
  for (const l of laps) {
    if (l.is_deleted) continue;
    bestByVehicle[l.vehicle_number] = Math.min(bestByVehicle[l.vehicle_number] ?? Infinity, l.lap_time_ms);
  }
  const competitors = vehicles.filter((v) => !tracked.has(v))
    .map((v) => [v, bestByVehicle[v] ?? Infinity])
    .sort((a, b) => a[1] - b[1])
    .slice(0, 5)
    .map(([v]) => v);
  return new Set([...tracked, ...competitors]);
}

function buildAllCarsDatasets() {
  const visible = visibleVehiclesForAllCars();
  const tracked = trackedVehicles();
  const byVehicle = {};
  for (const l of laps) {
    if (l.completed_at == null) continue;
    if (!visible.has(l.vehicle_number)) continue;
    (byVehicle[l.vehicle_number] ||= []).push(l);
  }
  return Object.entries(byVehicle).map(([vehicle, vlaps]) => {
    vlaps.sort((a, b) => tsMs(a) - tsMs(b));
    const isUs = tracked.has(vehicle);
    const points = vlaps.map((l) => ({ x: tsMs(l), y: l.lap_time_ms / 1000, _lap: l }));
    const ds = {
      label: `#${vehicle}` + (isUs ? " (us)" : ""),
      data: points,
      borderColor: isUs ? US_COLOR : vehicleColor(vehicle),
      backgroundColor: isUs ? US_COLOR : vehicleColor(vehicle),
      borderWidth: isUs ? 3 : 1.5,
      pointRadius: isUs ? 4 : 2,
      tension: 0.15,
    };
    if (isUs) {
      ds.segment = {
        borderColor: (ctx) => colorForLapByDriver(points[ctx.p1DataIndex]?._lap),
      };
      ds.pointBackgroundColor = (ctx) => colorForLapByDriver(points[ctx.dataIndex]?._lap);
      ds.pointBorderColor = (ctx) => colorForLapByDriver(points[ctx.dataIndex]?._lap);
    }
    return ds;
  });
}

function renderAllCarsChart() {
  const datasets = buildAllCarsDatasets();
  if (chartAllCars) {
    chartAllCars.data.datasets = datasets;
    chartAllCars.update("none");
    return;
  }
  chartAllCars = new Chart($("#chart-all-cars").getContext("2d"), {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "Time of day" },
          ticks: { color: "#8b93a7", callback: (v) => fmtTimeOfDay(v) },
          grid: { color: "#2a3140" },
        },
        y: { title: { display: true, text: "Lap time (s)" }, ticks: { color: "#8b93a7" }, grid: { color: "#2a3140" } },
      },
      plugins: {
        legend: { labels: { color: "#e6e8ee" } },
        tooltip: {
          callbacks: {
            title: (items) => items[0] ? fmtTimeOfDay(items[0].parsed.x) : "",
            label: (item) => {
              const lap = item.raw?._lap;
              const time = lap ? fmtLapMs(lap.lap_time_ms) : `${item.parsed.y.toFixed(3)}s`;
              const lapNum = lap?.lap_number ?? "?";
              const driverName = driverNameForLap(lap);
              return `${item.dataset.label} • Lap ${lapNum} • ${time}`
                   + (driverName ? ` • ${driverName}` : "");
            },
          },
        },
      },
    },
  });
}

function buildPositionDatasets() {
  const tracked = trackedVehicles();
  const byVehicle = {};
  for (const l of laps) {
    if (l.position == null || l.completed_at == null) continue;
    (byVehicle[l.vehicle_number] ||= []).push(l);
  }
  return Object.entries(byVehicle).map(([vehicle, vlaps]) => {
    vlaps.sort((a, b) => tsMs(a) - tsMs(b));
    const isUs = tracked.has(vehicle);
    const points = vlaps.map((l) => ({ x: tsMs(l), y: l.position, _lap: l }));
    const ds = {
      label: `#${vehicle}` + (isUs ? " (us)" : ""),
      data: points,
      borderColor: isUs ? US_COLOR : vehicleColor(vehicle),
      backgroundColor: isUs ? US_COLOR : vehicleColor(vehicle),
      borderWidth: isUs ? 3 : 1.5,
      pointRadius: isUs ? 4 : 2,
      tension: 0,
    };
    if (isUs) {
      ds.segment = {
        borderColor: (ctx) => colorForLapByDriver(points[ctx.p1DataIndex]?._lap),
      };
      ds.pointBackgroundColor = (ctx) => colorForLapByDriver(points[ctx.dataIndex]?._lap);
      ds.pointBorderColor = (ctx) => colorForLapByDriver(points[ctx.dataIndex]?._lap);
    }
    return ds;
  });
}

function renderPositionChart() {
  const datasets = buildPositionDatasets();
  if (chartPosition) {
    chartPosition.data.datasets = datasets;
    chartPosition.update("none");
    return;
  }
  chartPosition = new Chart($("#chart-position").getContext("2d"), {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "Time of day" },
          ticks: { color: "#8b93a7", callback: (v) => fmtTimeOfDay(v) },
          grid: { color: "#2a3140" },
        },
        y: {
          reverse: true,
          beginAtZero: false,
          title: { display: true, text: "Position" },
          ticks: { color: "#8b93a7", precision: 0, stepSize: 1 },
          grid: { color: "#2a3140" },
        },
      },
      plugins: {
        legend: { labels: { color: "#e6e8ee" } },
        tooltip: {
          callbacks: {
            title: (items) => items[0] ? fmtTimeOfDay(items[0].parsed.x) : "",
            label: (item) => {
              const lap = item.raw?._lap;
              const lapNum = lap?.lap_number ?? "?";
              const driverName = driverNameForLap(lap);
              return `${item.dataset.label} • P${item.parsed.y} • Lap ${lapNum}`
                   + (driverName ? ` • ${driverName}` : "");
            },
          },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Per-tracked-car laps tables
// ---------------------------------------------------------------------------

function renderOurCarsLaps() {
  const wrap = $("#our-cars-laps");
  if (!trackedCars.length) {
    wrap.innerHTML = `
      <section class="panel">
        <h2>Our cars laps</h2>
        <div class="muted">Pick at least one car in the "Our cars" panel above to start logging laps.</div>
      </section>`;
    return;
  }

  const driverById = Object.fromEntries(drivers.map((d) => [d.id, d]));
  const driverOpts = (selectedId) =>
    [`<option value="" ${selectedId == null ? "selected" : ""}>unassigned</option>`]
      .concat(drivers.map((d) =>
        `<option value="${d.id}" ${d.id === selectedId ? "selected" : ""}>${escapeHtml(d.name)}</option>`
      )).join("");

  wrap.innerHTML = trackedCars.map((tc) => {
    const carLaps = laps.filter((l) => l.vehicle_number === tc.vehicle_number)
                        .sort((a, b) => b.lap_number - a.lap_number);
    const currentDriver = tc.current_driver_id ? driverById[tc.current_driver_id] : null;
    const cdHTML = currentDriver
      ? `<span class="driver-stat">current driver:
           <span class="lap-color-chip" style="background:${driverColor(currentDriver)}; border-color:#00000080"></span>
           <strong>${escapeHtml(currentDriver.name)}</strong>
         </span>`
      : `<span class="driver-stat">no current driver set</span>`;

    if (!carLaps.length) {
      return `
        <section class="panel">
          <h2>Car #${escapeHtml(tc.vehicle_number)} laps</h2>
          <div class="row" style="margin-bottom:6px">${cdHTML}</div>
          <div class="muted">No laps yet for this car.</div>
        </section>`;
    }

    const rowsHTML = carLaps.map((lap) => {
      const driver = lap.driver_id ? driverById[lap.driver_id] : null;
      const chipColor = driver ? driverColor(driver) : "transparent";
      const chipBorder = driver ? "#00000080" : "var(--border)";
      const stint = lap.tyre_stint || 1;
      const stintClass = `s${((stint - 1) % 5) + 1}`;
      const isFast = lap.lap_time_ms < FAST_LAP_THRESHOLD_MS;
      return `
        <tr class="us ${isFast ? "fast" : ""}">
          <td><span class="lap-color-chip" style="background:${chipColor}; border-color:${chipBorder}"></span></td>
          <td>${lap.lap_number}</td>
          <td>${fmtLapMs(lap.lap_time_ms)}</td>
          <td><span class="stint-badge ${stintClass}" title="tyre stint">S${stint}</span></td>
          <td>
            <select class="lap-driver" data-lap="${lap.id}">
              ${driverOpts(lap.driver_id)}
            </select>
          </td>
          <td>
            <input type="text" class="lap-note-input" data-lap="${lap.id}"
                   placeholder="note…" value="${escapeHtml(lap.note || "")}" />
          </td>
          <td><button class="danger" data-act="delete-lap" data-lap="${lap.id}">Delete</button></td>
        </tr>`;
    }).join("");

    return `
      <section class="panel">
        <h2>Car #${escapeHtml(tc.vehicle_number)} laps</h2>
        <div class="row" style="margin-bottom:6px">${cdHTML}</div>
        <div style="max-height: 380px; overflow:auto">
          <table>
            <thead>
              <tr><th></th><th>Lap</th><th>Time</th><th>Tyres</th><th>Driver</th><th>Note</th><th></th></tr>
            </thead>
            <tbody>${rowsHTML}</tbody>
          </table>
        </div>
      </section>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

function renderLeaderboard(rows) {
  const tbody = $("#leaderboard tbody");
  const tracked = trackedVehicles();
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">No data yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, i) => `
    <tr class="${tracked.has(r.vehicle_number) ? "us" : ""}">
      <td>${i + 1}</td>
      <td>#${escapeHtml(r.vehicle_number)}</td>
      <td>${r.laps_completed}</td>
      <td>${fmtLapMs(r.best_lap_ms)}</td>
      <td>${fmtLapMs(r.last_lap_ms)}</td>
      <td>${fmtLapMs(r.avg_lap_ms)}</td>
    </tr>
  `).join("");
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadAll() {
  const [ev, drv, veh, lp, lb, tc] = await Promise.all([
    API.getEvent(EVENT_ID),
    API.listDrivers(EVENT_ID),
    API.listVehicles(EVENT_ID),
    API.listLaps(EVENT_ID),
    API.leaderboard(EVENT_ID),
    API.listTracked(EVENT_ID),
  ]);
  event_ = ev; drivers = drv; vehicles = veh; laps = lp; trackedCars = tc;
  renderAll(lb);
}

async function tick() {
  try {
    const [ev, drv, veh, lp, lb, tc] = await Promise.all([
      API.getEvent(EVENT_ID),
      API.listDrivers(EVENT_ID),
      API.listVehicles(EVENT_ID),
      API.listLaps(EVENT_ID),
      API.leaderboard(EVENT_ID),
      API.listTracked(EVENT_ID),
    ]);
    event_ = ev; drivers = drv; vehicles = veh; laps = lp; trackedCars = tc;
    renderAll(lb, { skipDriverCardsIfEditing: true, skipLapsIfEditingNote: true });
  } catch (err) {
    console.error("tick failed", err);
  }
}

function renderAll(leaderboardRows, opts = {}) {
  renderHeader();
  renderTrackedCars();
  if (!opts.skipDriverCardsIfEditing || editingDriverId == null) renderDriverCards();
  renderAllDriversChart();
  renderAllCarsChart();
  renderPositionChart();
  // Don't blow away an in-progress lap-note edit on every tick: skip the
  // re-render if the user is currently typing in a note input.
  if (!opts.skipLapsIfEditingNote || !document.activeElement?.classList?.contains("lap-note-input")) {
    renderOurCarsLaps();
  }
  renderLeaderboard(leaderboardRows);
}

// ---------------------------------------------------------------------------
// Colour palette popover
// ---------------------------------------------------------------------------

function showColorPalette(driverId, anchorEl) {
  const palette = $("#color-palette");
  palette.innerHTML = PALETTE.map((c) =>
    `<button data-color="${c}" style="background:${c}" title="${c}"></button>`
  ).join("");
  palette.style.display = "grid";
  // Position next to swatch.
  const r = anchorEl.getBoundingClientRect();
  palette.style.top = `${window.scrollY + r.bottom + 6}px`;
  palette.style.left = `${window.scrollX + r.left}px`;
  palette.dataset.driver = driverId;

  // Close on outside click (capturing once).
  setTimeout(() => {
    document.addEventListener("click", hideColorPaletteOnOutside, { once: true, capture: true });
  });
}

function hideColorPalette() {
  const palette = $("#color-palette");
  palette.style.display = "none";
  palette.innerHTML = "";
  delete palette.dataset.driver;
}

function hideColorPaletteOnOutside(e) {
  const palette = $("#color-palette");
  if (palette.contains(e.target)) return;   // re-arm — palette click handler will close
  if (e.target.closest('[data-act="pick-color"]')) return;  // swatch click handles itself
  hideColorPalette();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

$("#track-btn").addEventListener("click", async () => {
  const btn = $("#track-btn");
  btn.disabled = true;
  try {
    if (event_.is_tracking) await API.stopTracking(EVENT_ID);
    else await API.startTracking(EVENT_ID);
    await loadAll();
  } catch (err) {
    alert("Tracking action failed: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

$("#add-driver-btn").addEventListener("click", async () => {
  const name = $("#new-driver").value.trim();
  if (!name) return;
  try {
    await API.addDriver(EVENT_ID, { name });
    $("#new-driver").value = "";
    await loadAll();
  } catch (err) {
    alert("Add driver failed: " + err.message);
  }
});

$("#all-cars-filter").addEventListener("change", (e) => {
  allCarsFilter = e.target.value;
  renderAllCarsChart();
});

// Track which driver cards are open across re-renders.
document.addEventListener("toggle", (e) => {
  const card = e.target;
  if (!card || !card.classList || !card.classList.contains("driver-card")) return;
  const id = parseInt(card.dataset.driver, 10);
  if (card.open) expandedDrivers.add(id);
  else expandedDrivers.delete(id);
  if (card.open) {
    const driver = drivers.find((d) => d.id === id);
    if (driver) drawDriverMiniChart(driver);
  }
}, true);

document.addEventListener("click", async (e) => {
  // Colour palette: clicked a colour swatch button inside the palette
  const palBtn = e.target.closest("#color-palette button[data-color]");
  if (palBtn) {
    e.preventDefault();
    e.stopPropagation();
    const palette = $("#color-palette");
    const driverId = parseInt(palette.dataset.driver, 10);
    const color = palBtn.dataset.color;
    hideColorPalette();
    try {
      await API.updateDriver(driverId, { color });
      await loadAll();
    } catch (err) {
      alert("Update colour failed: " + err.message);
    }
    return;
  }

  // Driver swatch — open palette
  const swatch = e.target.closest('[data-act="pick-color"]');
  if (swatch) {
    e.preventDefault();
    e.stopPropagation();
    const driverId = parseInt(swatch.dataset.driver, 10);
    showColorPalette(driverId, swatch);
    return;
  }

  // Rename
  const renameBtn = e.target.closest('[data-act="rename"]');
  if (renameBtn) {
    e.preventDefault();
    e.stopPropagation();
    editingDriverId = parseInt(renameBtn.dataset.driver, 10);
    renderDriverCards();
    const inp = document.querySelector(`[data-act="rename-input"][data-driver="${editingDriverId}"]`);
    if (inp) { inp.focus(); inp.select(); }
    return;
  }
  const cancelBtn = e.target.closest('[data-act="rename-cancel"]');
  if (cancelBtn) {
    e.preventDefault();
    e.stopPropagation();
    editingDriverId = null;
    renderDriverCards();
    return;
  }
  const saveBtn = e.target.closest('[data-act="rename-save"]');
  if (saveBtn) {
    e.preventDefault();
    e.stopPropagation();
    const driverId = parseInt(saveBtn.dataset.driver, 10);
    const inp = document.querySelector(`[data-act="rename-input"][data-driver="${driverId}"]`);
    const newName = (inp?.value || "").trim();
    if (!newName) return;
    try {
      await API.updateDriver(driverId, { name: newName });
      editingDriverId = null;
      await loadAll();
    } catch (err) {
      alert("Rename failed: " + err.message);
    }
    return;
  }

  // Delete driver
  const delDriver = e.target.closest('[data-act="delete-driver"]');
  if (delDriver) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Remove this driver? Their lap allocations will be unassigned.")) return;
    try {
      await API.deleteDriver(delDriver.dataset.driver);
      expandedDrivers.delete(parseInt(delDriver.dataset.driver, 10));
      await loadAll();
    } catch (err) {
      alert("Delete driver failed: " + err.message);
    }
    return;
  }

  // Remove tracked car
  const removeTracked = e.target.closest('[data-act="remove-tracked"]');
  if (removeTracked) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await API.deleteTracked(removeTracked.dataset.tracked);
      await loadAll();
    } catch (err) {
      alert("Remove tracked car failed: " + err.message);
    }
    return;
  }

  // Tyre change
  const tyreBtn = e.target.closest('[data-act="tyre-change"]');
  if (tyreBtn) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await API.tyreChange(tyreBtn.dataset.tracked);
      await loadAll();
    } catch (err) {
      alert("Tyre change failed: " + err.message);
    }
    return;
  }

  // Soft delete a lap
  const delLap = e.target.closest('[data-act="delete-lap"]');
  if (delLap) {
    if (!confirm("Delete this lap? It will be excluded from stats and all charts.")) return;
    try {
      await API.deleteLap(delLap.dataset.lap);
      await tick();
    } catch (err) {
      alert("Delete lap failed: " + err.message);
    }
    return;
  }
});

// Tracked-car selects: vehicle picker + current-driver picker
document.addEventListener("change", async (e) => {
  // Tracked vehicle (slot picker — for empty slots)
  if (e.target.classList.contains("tracked-vehicle") && e.target.dataset.slot && !e.target.dataset.tracked) {
    const slot = parseInt(e.target.dataset.slot, 10);
    const vehicle = e.target.value;
    if (!vehicle) return;
    try {
      await API.addTracked(EVENT_ID, { vehicle_number: vehicle, slot });
      await loadAll();
    } catch (err) {
      alert("Add tracked car failed: " + err.message);
      await loadAll();
    }
    return;
  }
  // Tracked vehicle (existing)
  if (e.target.classList.contains("tracked-vehicle") && e.target.dataset.tracked) {
    const id = e.target.dataset.tracked;
    const vehicle = e.target.value;
    if (!vehicle) return;
    try {
      await API.updateTracked(id, { vehicle_number: vehicle });
      await loadAll();
    } catch (err) {
      alert("Update tracked car failed: " + err.message);
    }
    return;
  }
  // Current driver
  if (e.target.classList.contains("tracked-driver")) {
    const id = e.target.dataset.tracked;
    const driver_id = e.target.value ? parseInt(e.target.value, 10) : null;
    try {
      await API.updateTracked(id, { current_driver_id: driver_id });
      await loadAll();
    } catch (err) {
      alert("Update current driver failed: " + err.message);
    }
    return;
  }
  // Per-lap driver assignment
  if (e.target.classList.contains("lap-driver")) {
    const lapId = e.target.dataset.lap;
    const driver_id = e.target.value ? parseInt(e.target.value, 10) : null;
    try {
      await API.updateLap(lapId, { driver_id });
      await tick();
    } catch (err) {
      alert("Assign driver failed: " + err.message);
    }
  }
});

// Enter to save / Escape to cancel rename input.
document.addEventListener("keydown", (e) => {
  const inp = e.target.closest('[data-act="rename-input"]');
  if (!inp) return;
  if (e.key === "Enter") {
    e.preventDefault();
    document.querySelector(`[data-act="rename-save"][data-driver="${inp.dataset.driver}"]`)?.click();
  } else if (e.key === "Escape") {
    e.preventDefault();
    editingDriverId = null;
    renderDriverCards();
  }
});

// Lap-note debounced save. While the user is typing we don't want to PATCH on
// every keystroke; we wait NOTE_SAVE_DEBOUNCE_MS after the last input.
const noteSaveTimers = new Map();   // lapId -> timeout handle

function scheduleNoteSave(input) {
  const lapId = input.dataset.lap;
  if (!lapId) return;
  clearTimeout(noteSaveTimers.get(lapId));
  input.classList.remove("saved");
  input.classList.add("saving");
  const timer = setTimeout(async () => {
    const value = input.value;
    try {
      await API.updateLap(lapId, { note: value });
      input.classList.remove("saving");
      input.classList.add("saved");
      // Update local lap data so a refresh doesn't flicker the placeholder back.
      const lap = laps.find((l) => String(l.id) === String(lapId));
      if (lap) lap.note = value.trim() || null;
    } catch (err) {
      input.classList.remove("saving");
      console.error("save lap note failed", err);
      alert("Save lap note failed: " + err.message);
    }
  }, NOTE_SAVE_DEBOUNCE_MS);
  noteSaveTimers.set(lapId, timer);
}

document.addEventListener("input", (e) => {
  const inp = e.target.closest(".lap-note-input");
  if (!inp) return;
  scheduleNoteSave(inp);
});

// On blur, flush any pending save immediately.
document.addEventListener("blur", (e) => {
  const inp = e.target.closest?.(".lap-note-input");
  if (!inp) return;
  const lapId = inp.dataset.lap;
  if (noteSaveTimers.has(lapId)) {
    clearTimeout(noteSaveTimers.get(lapId));
    noteSaveTimers.delete(lapId);
    // Trigger immediate save by pretending a debounce just elapsed.
    (async () => {
      try {
        await API.updateLap(lapId, { note: inp.value });
        inp.classList.remove("saving");
        inp.classList.add("saved");
        const lap = laps.find((l) => String(l.id) === String(lapId));
        if (lap) lap.note = inp.value.trim() || null;
      } catch (err) {
        console.error("save lap note failed", err);
      }
    })();
  }
}, true);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadAll().then(() => {
  setInterval(tick, REFRESH_MS);
}).catch((err) => alert("Failed to load dashboard: " + err.message));
