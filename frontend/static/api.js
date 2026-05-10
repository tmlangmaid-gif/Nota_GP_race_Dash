// Tiny fetch wrapper. Throws on non-2xx with the response body as message.
// Auth header is included from window.Auth (auth.js must load before this file).
async function api(path, opts = {}) {
  const base = window.API_BASE || "";
  const authHeaders = (window.Auth && Auth.authHeader) ? Auth.authHeader() : {};
  // Spread opts BEFORE setting headers/body so a caller-provided `headers`
  // doesn't wipe Content-Type. (Same trap as auth.js.)
  const res = await fetch(base + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...authHeaders, ...(opts.headers || {}) },
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
    // Surface the human-readable detail when we can. FastAPI returns either
    // detail=string (HTTPException) or detail=[{loc,msg,type},...] (Pydantic
    // validation). Without this, Array.toString gives "[object Object]".
    let text = res.statusText;
    try {
      const data = await res.json();
      const d = data && data.detail;
      if (typeof d === "string") text = d;
      else if (Array.isArray(d)) text = d.map((e) => e && e.msg ? e.msg : JSON.stringify(e)).join("; ");
      else if (d) text = JSON.stringify(d);
      else text = JSON.stringify(data);
    } catch (_) {
      try { text = await res.text(); } catch (__) { /* leave statusText */ }
    }
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

  // event sharing — `listMembers` returns a mixed list of members and pending
  // invites. Each row carries `kind` ('member' | 'invite'); use it to dispatch
  // updates / deletes to the right route.
  listMembers: (eventId) => api(`/api/events/${eventId}/members`),
  addMember: (eventId, body) => api(`/api/events/${eventId}/members`, { method: "POST", body }),
  updateMember: (eventId, memberId, body) => api(`/api/events/${eventId}/members/${memberId}`, { method: "PATCH", body }),
  deleteMember: (eventId, memberId) => api(`/api/events/${eventId}/members/${memberId}`, { method: "DELETE" }),
  updateInvite: (eventId, inviteId, body) => api(`/api/events/${eventId}/invites/${inviteId}`, { method: "PATCH", body }),
  deleteInvite: (eventId, inviteId) => api(`/api/events/${eventId}/invites/${inviteId}`, { method: "DELETE" }),

  // drivers
  listDrivers: (eventId) => api(`/api/events/${eventId}/drivers`),
  addDriver: (eventId, body) => api(`/api/events/${eventId}/drivers`, { method: "POST", body }),
  updateDriver: (driverId, body) => api(`/api/drivers/${driverId}`, { method: "PATCH", body }),
  deleteDriver: (driverId) => api(`/api/drivers/${driverId}`, { method: "DELETE" }),

  // personal driver pool — "My drivers" — reusable across events
  listMyDrivers: () => api(`/api/drivers/mine`),
  addMyDriver: (body) => api(`/api/drivers/mine`, { method: "POST", body }),
  updateMyDriver: (id, body) => api(`/api/drivers/mine/${id}`, { method: "PATCH", body }),
  deleteMyDriver: (id) => api(`/api/drivers/mine/${id}`, { method: "DELETE" }),

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
