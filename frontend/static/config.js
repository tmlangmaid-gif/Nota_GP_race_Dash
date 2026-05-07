// Auto-detect dev vs production:
// - Locally (FastAPI serves the frontend) the API lives at the same origin → empty base.
// - On Vercel the frontend is hosted separately, so point at the Hostinger VPS backend.
(function () {
  const PROD_API_BASE = "https://api.speeddemondash.com";
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "";
  window.API_BASE = isLocal ? "" : PROD_API_BASE;
})();
