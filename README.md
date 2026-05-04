# Race Dash

Live-timing dashboard for racing.natsoft.com.au events. Scrapes the live results
page in a headless Chromium, stores laps in a database, and shows a per-event
dashboard with a leaderboard, lap-time chart, and per-lap driver tagging.

## How it works (architecture)

```
Natsoft live page  ←──(Playwright headless Chromium)──┐
                                                       │
                                          ┌────────────▼────────────┐
                                          │  FastAPI backend        │
                                          │  + scraper task per     │
                                          │    tracked event        │
                                          │  + SQLite or Postgres   │
                                          └────────────┬────────────┘
                                                       │ JSON API
                                          ┌────────────▼────────────┐
                                          │  Static frontend        │
                                          │  (HTML / JS / Chart.js) │
                                          └─────────────────────────┘
```

- The Natsoft page renders timing data via a binary WebSocket, so we use
  Playwright to load the page, let it render, then scrape the rendered table
  every ~3 seconds.
- One scraper task runs per event you tracked; it upserts laps into the DB
  keyed by `(event, vehicle_number, lap_number)` so polling is idempotent.
- A `demo://` URL bypasses Natsoft and emits synthetic lap data, so you can
  develop and test the dashboard without a live race.

## Running locally

```bash
python -m venv .venv
.venv/Scripts/activate          # PowerShell: .venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt
playwright install chromium     # one-time: downloads the browser

cd backend
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000.

The default DB is SQLite at `./data/race.db`. To use Postgres locally:

```bash
export DATABASE_URL='postgresql+psycopg://user:pass@localhost/racedash'
```

### Demo mode

In the **New event** form, paste `demo://` as the Natsoft URL. When you click
**Start tracking** on the dashboard, the synthetic scraper will start producing
laps for cars #7, #12, #23, #44, and #88 every ~3 seconds.

### Tracking a real Natsoft event

1. Go to http://racing.natsoft.com.au/results/ in a regular browser.
2. Drill down to the specific event/session you want to track.
3. Copy the URL (it will be a long URL with a session ID).
4. In Race Dash, **New event** → paste it.
5. Open the dashboard for that event → **Start tracking**.

The DOM extractor in `backend/app/scraper.py` is a best-effort generic table
parser. If your event's layout doesn't match, watch the backend logs (it
prints "no rows extracted this poll") and tweak `extract_laps()` and the
column-keyword sets at the top of the file.

## Using the dashboard

- **Pick our car** from the dropdown — the table on the left shows our laps,
  and our row is highlighted in the leaderboard and chart.
- **Add drivers** with the form on the right of the top panel.
- For each lap of our car, choose the driver in the dropdown — that allocates
  the lap to that driver in the database.
- **Delete** a lap (soft delete) to exclude it from stats and the leaderboard
  (e.g. when there was a stop-go penalty or a freak time).

The dashboard polls the API every 3 seconds — start tracking and just leave it
open during the race.

## Deploying

The intended split is **frontend on Vercel** + **backend (with scraper) on
Fly.io** + **Postgres on Neon or Supabase**. Vercel can't host the long-running
Playwright scraper.

### 1. Postgres

Create a Neon or Supabase project. Note the connection string — it will look
like:
```
postgresql+psycopg://USER:PASS@HOST/DB?sslmode=require
```
(Add the `+psycopg` driver tag if it's missing.)

### 2. Backend on Fly.io

```bash
fly auth login
fly apps create race-dash                       # pick a unique name
fly secrets set DATABASE_URL='postgresql+psycopg://...?sslmode=require' \
                ALLOWED_ORIGINS='https://YOUR-APP.vercel.app'
fly deploy --dockerfile backend/Dockerfile
```

The backend image is based on the official Playwright image, so Chromium is
preinstalled. Note the Fly URL it gives you (e.g. `https://race-dash.fly.dev`).

### 3. Frontend on Vercel

The frontend is `frontend/` — pure static HTML + JS, no build step.

1. Edit `frontend/static/config.js` and set `window.API_BASE` to your Fly URL:
   ```js
   window.API_BASE = "https://race-dash.fly.dev";
   ```
2. Either import the `frontend/` folder as a new Vercel project, or:
   ```bash
   cd frontend
   vercel deploy --prod
   ```
3. Add the resulting Vercel URL to `ALLOWED_ORIGINS` on Fly:
   ```bash
   fly secrets set ALLOWED_ORIGINS='https://your-app.vercel.app'
   ```

## Project layout

```
backend/
  app/
    main.py        FastAPI app, REST routes, lifespan
    db.py          SQLAlchemy engine/session (env-driven URL)
    models.py      Event, Driver, Lap
    schemas.py     Pydantic
    scraper.py     Playwright scraper + demo mode + manager
  Dockerfile
  requirements.txt
frontend/
  index.html       Events list + new event form
  dashboard.html   Per-event dashboard
  static/
    styles.css
    config.js      window.API_BASE — set this for split deployments
    api.js         Fetch wrapper + lap-time formatter
    app.js         Events page logic
    dashboard.js   Dashboard logic + Chart.js wiring
  vercel.json
fly.toml
```

## Known limitations / things to tune later

- **DOM extractor is generic.** Once you have a real Natsoft event, you'll
  almost certainly need to edit `extract_laps()` to match the actual column
  layout. The scraper logs the rows it finds — use that to iterate.
- **No auth.** Anyone with the Vercel URL can edit driver assignments. For a
  shared race-day setup that's usually fine; if you want auth later, the
  cheapest add is a single shared password via a header check in FastAPI.
- **Lap → driver allocation only on our car.** The dashboard only shows the
  driver dropdown for our car's laps. Competitors get their lap times tracked
  for the leaderboard but no driver allocation (which matches "all others are
  competitors" in the original spec).
- **Soft delete only.** Deleted laps stay in the DB; they're just hidden by
  default. Pass `?include_deleted=true` to `/api/events/{id}/laps` to recover.
