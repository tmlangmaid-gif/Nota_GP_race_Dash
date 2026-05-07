// Tiny fetch wrapper. Throws on non-2xx with the response body as message.
// Auth header is included from window.Auth (auth.js must load before this file).
async function api(path, opts = {}) {
  const base = window.API_BASE || "";
  const authHeaders = (window.Auth && Auth.authHeader) ? Auth.authHeader() : {};
  const res = await fetch(base + path, {
    headers: { "Content-Type": "application/json", ...authHeaders, ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    // Token rejected — clear it and bounce to login.
    if (window.Auth) Auth.clearToken();
    if (location.pathname !== "/login") location.replace("/login");
    const err = new Error("not authenticated");
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    let text;
    try { text = JSON.stringify(await res.json()); } catch (_) { text = await res.text().catch(() => res.statusText); }
    const err = new Error(`${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

const API = {
  // events
  listEvents: () => api("/api/events"),
  getEvent: (id) => api(`/api/events/${id}`),
  createEvent: (body) => api("/api/events", { method: "POST", body }),
  updateEvent: (id, body) => api(`/api/events/${id}`, { method: "PATCH", body }),
  deleteEvent: (id) => api(`/api/events/${id}`, { method: "DELETE" }),
  startTracking: (id) => api(`/api/events/${id}/start_tracking`, { method: "POST" }),
  stopTracking: (id) => api(`/api/events/${id}/stop_tracking`, { method: "POST" }),

  // event sharing
  listMembers: (eventId) => api(`/api/events/${eventId}/members`),
  addMember: (eventId, body) => api(`/api/events/${eventId}/members`, { method: "POST", body }),
  updateMember: (eventId, memberId, body) => api(`/api/events/${eventId}/members/${memberId}`, { method: "PATCH", body }),
  deleteMember: (eventId, memberId) => api(`/api/events/${eventId}/members/${memberId}`, { method: "DELETE" }),

  // drivers
  listDrivers: (eventId) => api(`/api/events/${eventId}/drivers`),
  addDriver: (eventId, body) => api(`/api/events/${eventId}/drivers`, { method: "POST", body }),
  updateDriver: (driverId, body) => api(`/api/drivers/${driverId}`, { method: "PATCH", body }),
  deleteDriver: (driverId) => api(`/api/drivers/${driverId}`, { method: "DELETE" }),

  // tracked cars
  listTracked: (eventId) => api(`/api/events/${eventId}/tracked`),
  addTracked: (eventId, body) => api(`/api/events/${eventId}/tracked`, { method: "POST", body }),
  updateTracked: (id, body) => api(`/api/tracked/${id}`, { method: "PATCH", body }),
  deleteTracked: (id) => api(`/api/tracked/${id}`, { method: "DELETE" }),
  tyreChange: (id) => api(`/api/tracked/${id}/tyre_change`, { method: "POST" }),

  // laps & vehicles
  listVehicles: (eventId) => api(`/api/events/${eventId}/vehicles`),
  listLaps: (eventId, opts = {}) => {
    const params = new URLSearchParams();
    if (opts.includeDeleted) params.set("include_deleted", "true");
    if (opts.vehicle) params.set("vehicle", opts.vehicle);
    const q = params.toString();
    return api(`/api/events/${eventId}/laps${q ? "?" + q : ""}`);
  },
  updateLap: (lapId, body) => api(`/api/laps/${lapId}`, { method: "PATCH", body }),
  deleteLap: (lapId) => api(`/api/laps/${lapId}`, { method: "DELETE" }),
  leaderboard: (eventId) => api(`/api/events/${eventId}/leaderboard`),

  // Scraper activity logs
  scraperLogs: (eventId, limit = 100) => api(`/api/events/${eventId}/scraper_logs?limit=${limit}`),

  // Natsoft meeting picker
  natsoftMeetings: (discipline) => api(`/api/natsoft/meetings?discipline=${discipline}`),
  natsoftResolve: (body) => api(`/api/natsoft/resolve_meeting`, { method: "POST", body }),

  // Paywall
  checkout: (eventId) => api(`/api/events/${eventId}/checkout`, { method: "POST" }),
  applyCode: (eventId, code) => api(`/api/events/${eventId}/apply_code`, { method: "POST", body: { code } }),
};

// Format milliseconds as M:SS.mmm or SS.mmm
function fmtLapMs(ms) {
  if (ms == null) return "—";
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(3);
  return minutes > 0 ? `${minutes}:${seconds.padStart(6, "0")}` : seconds;
}
