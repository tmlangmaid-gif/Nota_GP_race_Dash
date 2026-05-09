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
let currentUser = null;
let myDrivers = [];     // user's personal pool, used for quick-pick chips below the add-driver input
let members = [];        // [{id, user_id, email, role}], owner-only for now
let carsView = "both";   // "1" | "2" | "both" — which car-column(s) to show
let chartAllDrivers = null;
let chartAllCars = null;
let chartPosition = null;
let allCarsFilter = "tracked";
const driverMiniCharts = new Map();
const carLapChartsBySlot = new Map();   // slot (1|2) -> Chart instance for that car's lap-time history
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

// Backend auto-stops scrapers 12 hours after they were started — keep this
// in sync with TRACKING_AUTO_STOP_HOURS in backend/app/scraper.py.
const TRACKING_AUTO_STOP_HOURS = 12;

function fmtDurationShort(ms) {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function renderHeader() {
  $("#event-name").textContent = event_.name;
  const tag = $("#status-tag");
  if (event_.is_tracking) {
    let label = "LIVE";
    if (event_.tracking_started_at) {
      const startMs = new Date(event_.tracking_started_at).getTime();
      const remaining = startMs + TRACKING_AUTO_STOP_HOURS * 3600_000 - Date.now();
      // Show how much tracking time is left so the user can see the scraper
      // is still alive even after switching apps. Updates on every tick.
      label = `LIVE · ${fmtDurationShort(remaining)} left`;
    }
    tag.className = "tag live";
    tag.textContent = label;
    tag.title = event_.tracking_started_at
      ? `Tracking started ${new Date(event_.tracking_started_at).toLocaleString()} — auto-stops ${TRACKING_AUTO_STOP_HOURS}h after start`
      : "";
  } else {
    tag.className = "tag idle";
    tag.textContent = "idle";
    tag.title = "";
  }
  $("#track-btn").textContent = event_.is_tracking ? "Stop tracking" : "Start tracking";

  // Role badge — only show for non-owners.
  const roleBadge = $("#role-badge");
  if (event_.role && event_.role !== "owner") {
    roleBadge.textContent = event_.role;
    roleBadge.style.display = "";
  } else {
    roleBadge.style.display = "none";
  }

  // Read-only members can't tap Start tracking.
  const canWrite = event_.role !== "read";
  $("#track-btn").disabled = !canWrite;

  // Only the owner gets the Event settings button.
  $("#event-settings-btn").style.display = (event_.role === "owner") ? "" : "none";
}

// ---------------------------------------------------------------------------
// Per-car columns: each column contains its slot config + laps table.
// ---------------------------------------------------------------------------

function renderCarColumns() {
  // Tear down driver mini charts and per-car laps charts BEFORE swapping HTML —
  // their canvases are about to be detached, and Chart.js would otherwise
  // render into ghost nodes.
  for (const [, chart] of driverMiniCharts) chart.destroy();
  driverMiniCharts.clear();
  for (const [, chart] of carLapChartsBySlot) chart.destroy();
  carLapChartsBySlot.clear();

  const bySlot = new Map(trackedCars.map((t) => [t.slot, t]));
  for (let s = 1; s <= MAX_TRACKED_SLOTS; s++) {
    const target = document.getElementById(`car-col-${s}`);
    if (!target) continue;
    const tc = bySlot.get(s) || null;

    // Preserve scroll position of the laps table across innerHTML swap.
    const oldScroll = document.getElementById(`laps-scroll-${s}`);
    const savedScroll = oldScroll ? oldScroll.scrollTop : 0;

    target.innerHTML =
      renderColumnHeaderHTML(s, tc)
      + renderSlotCardHTML(s, tc)
      + (tc ? renderCarDriversHTML(tc) : "")
      + (tc ? renderCarLapChartHTML(tc) : "")
      + (tc ? renderSlotLapsHTML(tc) : "");

    if (savedScroll > 0) {
      const newScroll = document.getElementById(`laps-scroll-${s}`);
      if (newScroll) newScroll.scrollTop = savedScroll;
    }

    // Draw the per-car laps chart now that the canvas is in the DOM.
    if (tc) drawCarLapChart(s, tc);
  }
  // Re-draw mini charts for any expanded driver cards (now in the new DOM).
  for (const id of expandedDrivers) {
    const driver = drivers.find((d) => d.id === id);
    if (driver) drawDriverMiniChart(driver);
  }
  // Apply the view-toggle classes so we hide the right column(s).
  const grid = document.getElementById("cars-grid");
  if (grid) {
    grid.classList.toggle("single", carsView !== "both");
    grid.classList.toggle("hide-1", carsView === "2");
    grid.classList.toggle("hide-2", carsView === "1");
  }
  // Active state on the toggle buttons.
  document.querySelectorAll("#cars-view-toggle button").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === carsView);
  });
}

function renderColumnHeaderHTML(slot, tc) {
  // Big header sitting above each column so left/right unmistakably == Slot 1/Slot 2.
  if (!tc) {
    return `
      <div class="car-col-header empty">
        <div class="slot-label">SLOT ${slot}</div>
        <div class="muted" style="font-size:12px;">no car selected</div>
      </div>`;
  }
  // Show the user-given name prominently (e.g. "BMW") with the car number as
  // a subtle annotation. Falls back to "Car #N" when there's no name.
  const titleHTML = tc.name
    ? `<div class="car-title">${escapeHtml(tc.name)} <span class="car-num-badge">#${escapeHtml(tc.vehicle_number)}</span></div>`
    : `<div class="car-title">Car #${escapeHtml(tc.vehicle_number)}</div>`;
  return `
    <div class="car-col-header">
      <div class="slot-label">SLOT ${slot}</div>
      ${titleHTML}
    </div>`;
}

function renderCarDriversHTML(tc) {
  // Per-car drivers panel: every driver rostered to this car (Driver.vehicle_number
  // matches), with their per-car stats. Includes its own "Add driver" form so
  // the form lives in the same column as the car the driver belongs to.
  const carDrivers = drivers.filter((d) => d.vehicle_number === tc.vehicle_number);

  // Build per-driver stats (total, best, top 3) over this car's laps only.
  const carLaps = laps.filter((l) => l.vehicle_number === tc.vehicle_number && !l.is_deleted);
  const lapsByDriver = {};
  for (const l of carLaps) {
    if (l.driver_id != null) (lapsByDriver[l.driver_id] ||= []).push(l);
  }
  const decorated = carDrivers.map((d) => {
    const dlaps = lapsByDriver[d.id] || [];
    const times = dlaps.map((l) => l.lap_time_ms);
    return {
      d,
      total: dlaps.length,
      best: times.length ? Math.min(...times) : null,
      topChips: [...dlaps].sort((a, b) => a.lap_time_ms - b.lap_time_ms).slice(0, 5),
    };
  }).sort((a, b) => {
    if (a.best == null && b.best == null) return a.d.name.localeCompare(b.d.name);
    if (a.best == null) return 1;
    if (b.best == null) return -1;
    return a.best - b.best;
  });

  const fastestId = decorated.find((x) => x.best != null)?.d.id ?? null;

  const cardsHTML = decorated.length === 0
    ? `<div class="muted" style="font-size:12px;">No drivers on this car yet. Add one below.</div>`
    : decorated.map(({ d, total, best, topChips }) => {
        const color = driverColor(d);
        const isOpen = expandedDrivers.has(d.id);
        const isEditing = editingDriverId === d.id;
        const isFastest = d.id === fastestId;
        const top5 = topChips;
        const topChipsHTML = topChips.length === 0
          ? `<span class="muted" style="font-size:12px">no laps yet</span>`
          : topChips.map((l, i) => `
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
              <span class="driver-stat">total laps <strong style="font-size:14px; color: var(--text);">${total}</strong></span>
              <span class="driver-stat">best <strong>${fmtLapMs(best)}</strong></span>
              <span class="driver-actions">
                ${isEditing
                  ? `<button data-act="rename-save" data-driver="${d.id}" class="primary">Save</button>
                     <button data-act="rename-cancel" data-driver="${d.id}">Cancel</button>`
                  : `<button class="icon-btn" data-act="rename" data-driver="${d.id}">Rename</button>`}
                <button class="icon-btn" data-act="delete-driver" data-driver="${d.id}">×</button>
              </span>
              <div class="top5-strip">${topChipsHTML}</div>
            </summary>
            <div class="body">
              <div>
                <h3 style="margin:0 0 6px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em;">
                  All laps (${top5.length === 5 ? "best 5 shown — see laps table for full list" : "top 5"})
                </h3>
                ${top5.length === 0
                  ? `<div class="muted">No laps assigned to this driver yet.</div>`
                  : `<table>
                       <thead><tr><th>#</th><th>Lap</th><th>Time</th></tr></thead>
                       <tbody>
                         ${top5.map((l, i) => `<tr><td>${i + 1}</td><td>${l.lap_number}</td><td>${fmtLapMs(l.lap_time_ms)}</td></tr>`).join("")}
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
          </details>`;
      }).join("");

  // Quick-pick chips: pool drivers we haven't already added to this car.
  // The user's personal pool (myDrivers) is loaded once at boot and refreshed
  // on each tick. Chips show drivers from previous events so the user doesn't
  // have to retype names.
  const carDriverNames = new Set(
    drivers.filter((d) => d.vehicle_number === tc.vehicle_number).map((d) => d.name.toLowerCase())
  );
  const poolUnused = myDrivers.filter((md) => !carDriverNames.has(md.name.toLowerCase())).slice(0, 24);
  const chipsHTML = poolUnused.length
    ? `<div class="driver-pool-chips" style="margin: -4px 0 10px 0; display: flex; flex-wrap: wrap; gap: 4px;">
         <span class="muted" style="font-size: 11px; align-self: center; margin-right: 2px;">Quick-add:</span>
         ${poolUnused.map((md) => `
           <button class="icon-btn pool-chip"
                   data-act="add-pool-driver"
                   data-tracked="${tc.id}"
                   data-name="${escapeHtml(md.name)}"
                   data-color="${escapeHtml(md.color || "")}"
                   style="font-size: 11px; padding: 2px 8px; ${md.color ? `border-color:${md.color}; color:${md.color};` : ""}">
             ${escapeHtml(md.name)}
           </button>`).join("")}
       </div>`
    : "";

  return `
    <section class="panel">
      <h3>Drivers</h3>
      <div class="row" style="margin-bottom: 6px;">
        <input type="text" class="new-car-driver-input" data-tracked="${tc.id}" placeholder="Driver name" style="flex: 1;" />
        <button class="primary" data-act="add-car-driver" data-tracked="${tc.id}">Add</button>
      </div>
      ${chipsHTML}
      ${cardsHTML}
    </section>`;
}

function renderSlotCardHTML(slot, tc) {
  const vehicleOpts = ['<option value="">— pick a car —</option>']
    .concat(vehicles.map((v) =>
      `<option value="${escapeHtml(v)}" ${tc && v === tc.vehicle_number ? "selected" : ""}>#${escapeHtml(v)}</option>`
    )).join("");
  const driverOpts = ['<option value="">— no current driver —</option>']
    .concat(drivers.map((d) =>
      `<option value="${d.id}" ${tc && d.id === tc.current_driver_id ? "selected" : ""}>${escapeHtml(d.name)}</option>`
    )).join("");

  // Empty slot: either the vehicles list is empty (waiting for laps) or we offer a picker.
  if (!tc) {
    if (vehicles.length === 0) {
      return `
        <section class="panel">
          <div class="muted" style="font-size:13px;">
            ${event_.is_tracking
              ? "Waiting for the first laps to come in — cars appear here as soon as the live timing reports any lap (~3s for demo)."
              : "Click <strong>Start tracking</strong> at the top right. Cars will appear here once the live timing reports any lap."}
          </div>
        </section>`;
    }
    return `
      <section class="panel">
        <div class="row">
          <label>Pick a car:</label>
          <select class="tracked-vehicle" data-slot="${slot}">${vehicleOpts}</select>
        </div>
      </section>`;
  }

  // Filled slot: show the full config card.
  const carLaps = laps.filter((l) => l.vehicle_number === tc.vehicle_number && !l.is_deleted);
  const lapsOnTyres = carLaps.filter((l) => (l.tyre_stint || 1) === (tc.tyre_stint || 1)).length;
  return `
    <section class="panel">
      <div class="row" style="justify-content: flex-end; margin-bottom: 4px;">
        <button class="icon-btn" data-act="remove-tracked" data-tracked="${tc.id}" title="remove">Remove</button>
      </div>
      <div class="row">
        <label>Vehicle</label>
        <select class="tracked-vehicle" data-tracked="${tc.id}">${vehicleOpts}</select>
      </div>
      <div class="row">
        <label>Car name</label>
        <input type="text" class="tracked-name" data-tracked="${tc.id}"
               value="${escapeHtml(tc.name || "")}"
               placeholder="e.g. 'BMW' or 'Red Beast'" style="flex:1; min-width: 140px;" />
      </div>
      <div class="row">
        <label>Current driver</label>
        <select class="tracked-driver" data-tracked="${tc.id}">${driverOpts}</select>
      </div>
      <div class="row" style="margin-top: 6px; padding-top: 8px; border-top: 1px dashed var(--border);">
        <label>Tyres</label>
        <span class="driver-stat">
          <span class="stint-badge s${((tc.tyre_stint || 1) - 1) % 5 + 1}">stint ${tc.tyre_stint || 1}</span>
          <strong>${lapsOnTyres}</strong> lap${lapsOnTyres === 1 ? "" : "s"} on
        </span>
        <button class="icon-btn" data-act="tyre-change" data-tracked="${tc.id}">Tyre change</button>
      </div>
    </section>`;
}

function renderCarLapChartHTML(tc) {
  return `
    <section class="panel">
      <h3>Lap times — colour by driver</h3>
      <div class="muted" style="font-size:12px; margin-bottom:6px">
        Each segment is coloured by whoever was driving on that lap.
      </div>
      <div class="driver-mini-chart-wrap" style="height: 240px;">
        <canvas id="car-lap-chart-${tc.slot}"></canvas>
      </div>
    </section>`;
}

function drawCarLapChart(slot, tc) {
  const canvas = document.getElementById(`car-lap-chart-${slot}`);
  if (!canvas) return;
  const carLaps = laps.filter((l) => l.vehicle_number === tc.vehicle_number && !l.is_deleted)
                      .sort((a, b) => a.lap_number - b.lap_number);
  const points = carLaps.map((l) => ({ x: l.lap_number, y: l.lap_time_ms / 1000, _lap: l }));
  const fastThreshold = event_?.min_lap_warning_ms ?? FAST_LAP_THRESHOLD_MS;

  const chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      datasets: [{
        label: tc.name ? `${tc.name} (#${tc.vehicle_number})` : `#${tc.vehicle_number}`,
        data: points,
        borderColor: US_COLOR,
        backgroundColor: US_COLOR,
        borderWidth: 3,
        pointRadius: 4,
        tension: 0.15,
        segment: {
          borderColor: (ctx) => colorForLapByDriver(points[ctx.p1DataIndex]?._lap),
        },
        pointBackgroundColor: (ctx) => colorForLapByDriver(points[ctx.dataIndex]?._lap),
        pointBorderColor: (ctx) => colorForLapByDriver(points[ctx.dataIndex]?._lap),
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
              const dn = driverNameForLap(lap);
              return `${time}` + (dn ? ` • ${dn}` : "") + (lap && lap.lap_time_ms < fastThreshold ? " • ⚠ fast" : "");
            },
          },
        },
      },
    },
  });
  carLapChartsBySlot.set(slot, chart);
}

function renderSlotLapsHTML(tc) {
  const carLaps = laps.filter((l) => l.vehicle_number === tc.vehicle_number)
                      .sort((a, b) => b.lap_number - a.lap_number);
  // Per-event threshold (defaults to 1:12.000 if unset).
  const fastThreshold = event_?.min_lap_warning_ms ?? FAST_LAP_THRESHOLD_MS;
  if (!carLaps.length) {
    return `
      <section class="panel">
        <h3>Laps</h3>
        <div class="muted">No laps yet for this car.</div>
      </section>`;
  }

  const driverById = Object.fromEntries(drivers.map((d) => [d.id, d]));

  // Build the click-to-expand driver picker. Shows the current driver as a
  // coloured chip; clicking it reveals other drivers + an "unassigned" option.
  function pickerHTML(lap, currentDriver) {
    const otherDrivers = drivers.filter((d) => d.id !== lap.driver_id);
    const unassignedOption = lap.driver_id != null
      ? `<button data-act="set-driver" data-lap="${lap.id}" data-driver=""><span class="dot unassigned"></span>unassigned</button>`
      : "";
    const optsHTML = unassignedOption + otherDrivers.map((d) =>
      `<button data-act="set-driver" data-lap="${lap.id}" data-driver="${d.id}">
         <span class="dot" style="background:${driverColor(d)}"></span>${escapeHtml(d.name)}
       </button>`
    ).join("");
    const currentBtn = currentDriver
      ? `<button class="driver-current" data-act="toggle-driver-picker">
           <span class="dot" style="background:${driverColor(currentDriver)}"></span>
           <span>${escapeHtml(currentDriver.name)}</span>
           <span class="caret">▾</span>
         </button>`
      : `<button class="driver-current unassigned" data-act="toggle-driver-picker">
           <span class="dot unassigned"></span>
           <span>unassigned</span>
           <span class="caret">▾</span>
         </button>`;
    return `
      <div class="driver-picker" data-lap="${lap.id}">
        ${currentBtn}
        <div class="driver-options">${optsHTML || '<span class="muted" style="padding:4px 8px;font-size:12px">no drivers added</span>'}</div>
      </div>`;
  }

  const rowsHTML = carLaps.map((lap) => {
    const driver = lap.driver_id ? driverById[lap.driver_id] : null;
    const chipColor = driver ? driverColor(driver) : "transparent";
    const chipBorder = driver ? "#00000080" : "var(--border)";
    const stint = lap.tyre_stint || 1;
    const stintClass = `s${((stint - 1) % 5) + 1}`;
    const isFast = lap.lap_time_ms < fastThreshold;
    return `
      <tr class="us ${isFast ? "fast" : ""}">
        <td><span class="lap-color-chip" style="background:${chipColor}; border-color:${chipBorder}"></span></td>
        <td>${lap.lap_number}</td>
        <td class="lap-time-cell">${fmtLapMs(lap.lap_time_ms)}</td>
        <td><span class="stint-badge ${stintClass}" title="tyre stint">S${stint}</span></td>
        <td>${pickerHTML(lap, driver)}</td>
        <td>
          <input type="text" class="lap-note-input" data-lap="${lap.id}"
                 placeholder="note…" value="${escapeHtml(lap.note || "")}" />
        </td>
        <td><button class="danger" data-act="delete-lap" data-lap="${lap.id}">Delete</button></td>
      </tr>`;
  }).join("");

  return `
    <section class="panel">
      <h3>Laps</h3>
      <div id="laps-scroll-${tc.slot}" style="max-height: 480px; overflow:auto">
        <table>
          <thead>
            <tr><th></th><th>Lap</th><th>Time</th><th>Tyres</th><th>Driver</th><th>Note</th><th></th></tr>
          </thead>
          <tbody>${rowsHTML}</tbody>
        </table>
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Driver cards
// ---------------------------------------------------------------------------

function lapsByDriverId(driverId) {
  return laps.filter((l) => l.driver_id === driverId)
             .sort((a, b) => a.lap_number - b.lap_number);
}

// Driver cards are now rendered per-car inside renderCarDriversHTML, called
// from renderCarColumns. We keep the mini-chart lifecycle helpers + the
// "redraw expanded charts" pass below.

function drawDriverMiniChart(driver) {
  const canvas = document.getElementById(`driver-mini-${driver.id}`);
  if (!canvas) return;
  const dlaps = lapsByDriverId(driver.id);
  const data = dlaps.map((l) => ({ x: l.lap_number, y: l.lap_time_ms / 1000, _lap: l }));
  const color = driverColor(driver);

  // Mini charts are always created fresh after the parent card re-renders,
  // because we destroyed all mini charts in renderCarColumns().
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
// Leaderboard
// ---------------------------------------------------------------------------

function renderAllLapsFeed() {
  const tbody = document.querySelector("#all-laps-feed tbody");
  if (!tbody) return;
  const tracked = trackedVehicles();
  const visible = laps.filter((l) => l.completed_at && !l.is_deleted);
  visible.sort((a, b) => tsMs(b) - tsMs(a));
  const rows = visible.slice(0, 80);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">No laps yet.</td></tr>`;
    return;
  }

  // Preserve scroll position across the innerHTML swap (same trick as the per-car laps tables).
  const wrap = document.getElementById("all-laps-feed-wrap");
  const savedScroll = wrap ? wrap.scrollTop : 0;

  tbody.innerHTML = rows.map((l) => {
    const isUs = tracked.has(l.vehicle_number);
    return `
      <tr class="${isUs ? "us" : ""}">
        <td>${fmtTimeOfDay(tsMs(l))}</td>
        <td><strong>#${escapeHtml(l.vehicle_number)}</strong></td>
        <td>${l.lap_number}</td>
        <td class="lap-time-cell">${fmtLapMs(l.lap_time_ms)}</td>
        <td>${l.position ?? "—"}</td>
      </tr>`;
  }).join("");

  if (savedScroll > 0 && wrap) wrap.scrollTop = savedScroll;
}

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
  const [ev, drv, veh, lp, lb, tc, mine] = await Promise.all([
    API.getEvent(EVENT_ID),
    API.listDrivers(EVENT_ID),
    API.listVehicles(EVENT_ID),
    API.listLaps(EVENT_ID),
    API.leaderboard(EVENT_ID),
    API.listTracked(EVENT_ID),
    API.listMyDrivers().catch(() => []),
  ]);
  event_ = ev; drivers = drv; vehicles = veh; laps = lp; trackedCars = tc; myDrivers = mine;
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
    renderAll(lb, { skipDriverCardsIfEditing: true, skipCarColumnsIfEditingNote: true });
    // If the webhook flipped is_paid=true while the modal was open, hide it.
    if (window.Paywall) window.Paywall.noteEventUpdate(ev);
  } catch (err) {
    console.error("tick failed", err);
  }
}

function renderAll(leaderboardRows, opts = {}) {
  renderHeader();
  // Driver cards live inside renderCarColumns now — nothing to call here.
  renderAllDriversChart();
  renderAllCarsChart();
  renderPositionChart();
  // Cars columns now contain the laps tables — skip re-render if a note is being edited
  // so we don't blow away the user's in-progress text.
  // Skip the per-car columns re-render if the user is currently typing in
  // either a lap-note input or the per-car description input. Otherwise we
  // wipe their text mid-typing.
  const ae = document.activeElement;
  const editingNote = ae?.classList?.contains("lap-note-input");
  const editingCarName = ae?.classList?.contains("tracked-name");
  const editingNewDriver = ae?.classList?.contains("new-car-driver-input");
  // If the user has the per-lap driver picker open, the next tick's re-render
  // would destroy the dropdown DOM and snap it shut. Hold off until they
  // close it (by picking, by clicking outside, or by reopening another).
  const driverPickerOpen = !!document.querySelector(".driver-picker.open");
  if (!opts.skipCarColumnsIfEditingNote || (!editingNote && !editingCarName && !editingNewDriver && !driverPickerOpen)) {
    renderCarColumns();
  }
  renderAllLapsFeed();
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

// Per-car add-driver lives under [data-act="add-car-driver"] in the click listener
// below — drivers belong to a specific car via Driver.vehicle_number.

$("#all-cars-filter").addEventListener("change", (e) => {
  allCarsFilter = e.target.value;
  renderAllCarsChart();
});

// Cars-view toggle: Car 1 / Car 2 / Both
document.querySelectorAll("#cars-view-toggle button").forEach((btn) => {
  btn.addEventListener("click", () => {
    carsView = btn.dataset.view;
    renderCarColumns();
  });
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
    renderCarColumns();
    const inp = document.querySelector(`[data-act="rename-input"][data-driver="${editingDriverId}"]`);
    if (inp) { inp.focus(); inp.select(); }
    return;
  }
  const cancelBtn = e.target.closest('[data-act="rename-cancel"]');
  if (cancelBtn) {
    e.preventDefault();
    e.stopPropagation();
    editingDriverId = null;
    renderCarColumns();
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

  // Per-car: Add driver (typed-in name)
  const addCarDriver = e.target.closest('[data-act="add-car-driver"]');
  if (addCarDriver) {
    e.preventDefault();
    e.stopPropagation();
    const trackedId = parseInt(addCarDriver.dataset.tracked, 10);
    const tc = trackedCars.find((t) => t.id === trackedId);
    if (!tc) return;
    const inp = document.querySelector(`.new-car-driver-input[data-tracked="${trackedId}"]`);
    const name = (inp?.value || "").trim();
    if (!name) return;
    try {
      await API.addDriver(EVENT_ID, { name, vehicle_number: tc.vehicle_number });
      if (inp) inp.value = "";
      await loadAll();
    } catch (err) {
      alert("Add driver failed: " + err.message);
    }
    return;
  }

  // Per-car: Quick-add a driver from the user's personal pool. Adds an
  // event-scoped Driver row using the pool name (and inherits its colour
  // server-side). Same outcome as typing the name and clicking Add.
  const poolChip = e.target.closest('[data-act="add-pool-driver"]');
  if (poolChip) {
    e.preventDefault();
    e.stopPropagation();
    const trackedId = parseInt(poolChip.dataset.tracked, 10);
    const tc = trackedCars.find((t) => t.id === trackedId);
    if (!tc) return;
    const name = poolChip.dataset.name;
    const color = poolChip.dataset.color || null;
    try {
      await API.addDriver(EVENT_ID, { name, color, vehicle_number: tc.vehicle_number });
      await loadAll();
    } catch (err) {
      alert("Add driver failed: " + err.message);
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

  // Driver picker — toggle open/closed.
  // The dropdown uses position:fixed (so it isn't clipped by the laps table's
  // overflow:auto), so we set top/left from the trigger's bounding rect.
  const togglePicker = e.target.closest('[data-act="toggle-driver-picker"]');
  if (togglePicker) {
    e.preventDefault();
    e.stopPropagation();
    const picker = togglePicker.closest('.driver-picker');
    const wasOpen = picker.classList.contains("open");
    // Close any open pickers (and clear positioning so reopen recomputes fresh).
    document.querySelectorAll(".driver-picker.open").forEach((p) => {
      p.classList.remove("open");
      const opts = p.querySelector(".driver-options");
      if (opts) { opts.style.top = ""; opts.style.left = ""; opts.style.minWidth = ""; }
    });
    if (!wasOpen) {
      picker.classList.add("open");
      const opts = picker.querySelector(".driver-options");
      if (opts) {
        const r = togglePicker.getBoundingClientRect();
        const dropdownH = 6 + 28 * (drivers.length + 1); // rough estimate
        // Flip above if not enough space below.
        const flip = (r.bottom + dropdownH > window.innerHeight) && (r.top > dropdownH);
        opts.style.top = flip ? `${r.top - dropdownH - 4}px` : `${r.bottom + 4}px`;
        opts.style.left = `${r.left}px`;
        opts.style.minWidth = `${Math.max(150, r.width)}px`;
      }
    }
    return;
  }
  // Driver picker — pick an option
  const setDriver = e.target.closest('[data-act="set-driver"]');
  if (setDriver) {
    e.preventDefault();
    e.stopPropagation();
    const lapId = setDriver.dataset.lap;
    const driverIdRaw = setDriver.dataset.driver;
    const driver_id = driverIdRaw ? parseInt(driverIdRaw, 10) : null;
    document.querySelectorAll(".driver-picker.open").forEach((p) => p.classList.remove("open"));
    try {
      await API.updateLap(lapId, { driver_id });
      await tick();
    } catch (err) {
      alert("Assign driver failed: " + err.message);
    }
    return;
  }
  // Click outside any picker → close any open picker
  if (!e.target.closest(".driver-picker")) {
    document.querySelectorAll(".driver-picker.open").forEach((p) => p.classList.remove("open"));
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
  // Car name (e.g., "BMW")
  if (e.target.classList.contains("tracked-name")) {
    const id = e.target.dataset.tracked;
    try {
      await API.updateTracked(id, { name: e.target.value });
      await loadAll();
    } catch (err) {
      alert("Update car name failed: " + err.message);
    }
    return;
  }
});

// Enter to save / Escape to cancel rename input.
document.addEventListener("keydown", (e) => {
  const inp = e.target.closest('[data-act="rename-input"]');
  if (inp) {
    if (e.key === "Enter") {
      e.preventDefault();
      document.querySelector(`[data-act="rename-save"][data-driver="${inp.dataset.driver}"]`)?.click();
    } else if (e.key === "Escape") {
      e.preventDefault();
      editingDriverId = null;
      renderCarColumns();
    }
    return;
  }
  // Enter in the "Add driver" input fires the Add button.
  // Enter in any per-car "Add driver" input fires that car's Add button.
  if (e.target.classList.contains("new-car-driver-input") && e.key === "Enter") {
    e.preventDefault();
    const id = e.target.dataset.tracked;
    document.querySelector(`[data-act="add-car-driver"][data-tracked="${id}"]`)?.click();
    return;
  }
  // Enter in the event-settings "Add member" email input fires the Add button.
  if (e.target.id === "member-email" && e.key === "Enter") {
    e.preventDefault();
    document.getElementById("add-member-btn")?.click();
    return;
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
// Event settings modal (owner-only)
// ---------------------------------------------------------------------------

function openEventSettings() {
  if (!event_ || event_.role !== "owner") return;
  $("#event-name-input").value = event_.name;
  $("#min-lap-input").value = fmtLapMs(event_.min_lap_warning_ms ?? FAST_LAP_THRESHOLD_MS);
  $("#min-lap-msg").textContent = "";
  $("#public-toggle").checked = !!event_.is_public;
  $("#public-msg").textContent = "";
  $("#event-settings-modal").style.display = "flex";
  refreshMembers();
}

// Parse "M:SS.mmm" or plain seconds into milliseconds. Returns null if unparseable.
function parseLapInput(s) {
  if (!s) return null;
  s = String(s).trim();
  const mss = s.match(/^(\d+):(\d+(?:[.,]\d+)?)$/);
  if (mss) {
    const minutes = parseInt(mss[1], 10);
    const seconds = parseFloat(mss[2].replace(",", "."));
    return Math.round((minutes * 60 + seconds) * 1000);
  }
  const n = parseFloat(s.replace(",", "."));
  if (!isNaN(n)) return Math.round(n * 1000);
  return null;
}

function closeEventSettings() {
  $("#event-settings-modal").style.display = "none";
}

async function refreshMembers() {
  try {
    members = await API.listMembers(EVENT_ID);
  } catch (err) {
    members = [];
  }
  const wrap = $("#members-list");
  if (!members.length) {
    wrap.innerHTML = "";
    $("#members-empty").style.display = "block";
    return;
  }
  $("#members-empty").style.display = "none";
  wrap.innerHTML = members.map((m) => {
    // Pending invites (no Race Dash account yet) get a "pending signup" tag so
    // the owner can see the difference between someone watching and someone
    // who hasn't joined yet.
    const pendingTag = m.kind === "invite"
      ? '<span class="tag idle" style="font-size:10px; padding:1px 5px; margin-left:6px;">pending signup</span>'
      : "";
    return `
      <div class="member-row" data-kind="${m.kind}" data-id="${m.id}">
        <span class="email">${escapeHtml(m.email)}${pendingTag}</span>
        <select data-act="member-role" data-kind="${m.kind}" data-id="${m.id}">
          <option value="read"  ${m.role === "read"  ? "selected" : ""}>Read only</option>
          <option value="write" ${m.role === "write" ? "selected" : ""}>Can edit</option>
        </select>
        <button class="icon-btn" data-act="remove-member" data-kind="${m.kind}" data-id="${m.id}">Remove</button>
      </div>
    `;
  }).join("");
}

$("#event-settings-btn").addEventListener("click", openEventSettings);

document.addEventListener("click", async (e) => {
  if (e.target.closest('[data-act="close-event-settings"]')) {
    closeEventSettings();
    return;
  }
  // Backdrop click closes
  if (e.target.id === "event-settings-modal") {
    closeEventSettings();
    return;
  }
  if (e.target.id === "save-event-name") {
    const name = $("#event-name-input").value.trim();
    if (!name) { alert("Name cannot be empty"); return; }
    try {
      await API.updateEvent(EVENT_ID, { name });
      await loadAll();
      closeEventSettings();
    } catch (err) {
      alert("Save failed: " + err.message);
    }
    return;
  }
  if (e.target.id === "save-min-lap") {
    const msg = $("#min-lap-msg");
    const ms = parseLapInput($("#min-lap-input").value);
    if (ms == null) {
      msg.style.color = "var(--bad)";
      msg.textContent = "Couldn't parse that. Try \"1:12\", \"1:12.500\", \"72\", or \"72.5\".";
      return;
    }
    if (ms < 1000 || ms > 600_000) {
      msg.style.color = "var(--bad)";
      msg.textContent = "Must be between 1 second and 10 minutes.";
      return;
    }
    msg.style.color = "var(--muted)";
    msg.textContent = "Saving…";
    try {
      await API.updateEvent(EVENT_ID, { min_lap_warning_ms: ms });
      await loadAll();
      msg.style.color = "var(--accent-2)";
      msg.textContent = `Saved (${fmtLapMs(ms)})`;
    } catch (err) {
      msg.style.color = "var(--bad)";
      msg.textContent = err.message;
    }
    return;
  }
  if (e.target.id === "add-member-btn") {
    const email = $("#member-email").value.trim();
    const role = $("#member-role").value;
    if (!email) return;
    try {
      await API.addMember(EVENT_ID, { email, role });
      $("#member-email").value = "";
      await refreshMembers();
    } catch (err) {
      alert("Add member failed: " + err.message);
    }
    return;
  }
  const removeMember = e.target.closest('[data-act="remove-member"]');
  if (removeMember) {
    const kind = removeMember.dataset.kind || "member";
    const promptText = kind === "invite"
      ? "Withdraw this pending invite?"
      : "Remove this person from the event?";
    if (!confirm(promptText)) return;
    try {
      if (kind === "invite") {
        await API.deleteInvite(EVENT_ID, removeMember.dataset.id);
      } else {
        await API.deleteMember(EVENT_ID, removeMember.dataset.id);
      }
      await refreshMembers();
    } catch (err) {
      alert("Remove failed: " + err.message);
    }
    return;
  }
  if (e.target.id === "delete-event-btn") {
    if (!confirm("Permanently delete this event and all its data? This cannot be undone.")) return;
    try {
      await API.deleteEvent(EVENT_ID);
      location.replace("/");
    } catch (err) {
      alert("Delete failed: " + err.message);
    }
  }
});

document.addEventListener("change", async (e) => {
  // Public/private toggle in event settings
  if (e.target.id === "public-toggle") {
    const checked = e.target.checked;
    const msg = $("#public-msg");
    msg.style.color = "var(--muted)";
    msg.textContent = "Saving…";
    try {
      await API.updateEvent(EVENT_ID, { is_public: checked });
      await loadAll();
      msg.style.color = "var(--accent-2)";
      msg.textContent = checked ? "Public — anyone signed in can view." : "Private — only you and invited members.";
    } catch (err) {
      e.target.checked = !checked;   // revert UI
      msg.style.color = "var(--bad)";
      msg.textContent = err.message;
    }
    return;
  }
  const memberRoleSel = e.target.closest('[data-act="member-role"]');
  if (!memberRoleSel) return;
  const kind = memberRoleSel.dataset.kind || "member";
  try {
    if (kind === "invite") {
      await API.updateInvite(EVENT_ID, memberRoleSel.dataset.id, { role: memberRoleSel.value });
    } else {
      await API.updateMember(EVENT_ID, memberRoleSel.dataset.id, { role: memberRoleSel.value });
    }
    await refreshMembers();
  } catch (err) {
    alert("Update role failed: " + err.message);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function showLoadingBanner(title, detail = "") {
  const b = document.getElementById("dashboard-loading-banner");
  if (!b) return;
  document.getElementById("dashboard-loading-title").textContent = title;
  document.getElementById("dashboard-loading-detail").textContent = detail;
  b.style.display = "flex";
}
function hideLoadingBanner() {
  const b = document.getElementById("dashboard-loading-banner");
  if (b) b.style.display = "none";
}

function maybeHideLoadingBannerOnData() {
  // Hide the banner once we've seen at least one car/lap, OR if the user
  // is a read-only viewer and the event has no URL anyway.
  if (vehicles.length > 0 || laps.length > 0) hideLoadingBanner();
}

(async () => {
  showLoadingBanner("Loading dashboard…", "Fetching event details and any existing lap data.");
  currentUser = await Auth.requireAuth();
  await renderUserBar(currentUser);
  // Wire the per-event header links.
  const compLink = document.getElementById("competitors-link");
  if (compLink) compLink.href = `/competitors?event=${EVENT_ID}`;
  const quickLink = document.getElementById("compressed-link");
  if (quickLink) quickLink.href = `/compressed?event=${EVENT_ID}`;
  const activityLink = document.getElementById("activity-link");
  if (activityLink) activityLink.href = `/scraper-activity?event=${EVENT_ID}`;
  try {
    await loadAll();
  } catch (err) {
    hideLoadingBanner();
    if (err.status === 404) {
      alert("This event no longer exists, or you don't have access.");
      location.replace("/");
      return;
    }
    alert("Failed to load dashboard: " + err.message);
    return;
  }

  // Auto-start tracking. Skips when:
  //   * read-only members (can't start anyway)
  //   * event has no Natsoft URL set yet
  //   * already tracking
  const canWrite = event_.role !== "read";
  if (canWrite && event_.natsoft_url && !event_.is_tracking) {
    showLoadingBanner(
      "Starting tracker…",
      "Headless browser is connecting to Natsoft. First laps usually appear within ~15s."
    );
    try {
      await API.startTracking(EVENT_ID);
      await loadAll();
    } catch (err) {
      hideLoadingBanner();
      console.warn("Auto-start failed:", err);
    }
  }

  // Switch the banner to "waiting for first laps" if tracking started but no data yet.
  if (event_.is_tracking && vehicles.length === 0 && laps.length === 0) {
    showLoadingBanner(
      "Waiting for first laps…",
      "Scraper is polling Natsoft every 3 seconds. Cars appear here as soon as the live timing reports any lap."
    );
  } else {
    hideLoadingBanner();
  }

  // Handle Stripe success/cancel redirects (?paid=1 / ?paid=cancelled)
  // and arm the 10-second paywall countdown if this event isn't unlocked.
  if (window.Paywall) {
    Paywall.handleSuccessReturn();
    Paywall.onUnlocked = async () => {
      // Refresh the dashboard view so anything that was hidden on read-only
      // unpaid mode reappears.
      await loadAll();
    };
    Paywall.armPaywallTimer(event_);
  }

  setInterval(async () => {
    await tick();
    maybeHideLoadingBannerOnData();
  }, REFRESH_MS);
})();
