// Auto-detect dev vs production:
// - Locally (FastAPI serves the frontend) the API lives at the same origin → empty base.
// - On Vercel the frontend is hosted separately, so point at the Fly.io backend URL.
//
// After deploying the backend to Fly, replace `PROD_API_BASE` below with your Fly URL
// (e.g. "https://race-dash.fly.dev"), commit, push — Vercel will auto-redeploy.
(function () {
  const PROD_API_BASE = "https://racedash.srv1595222.hstgr.cloud";
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "";
  window.API_BASE = isLocal ? "" : PROD_API_BASE;
})();
