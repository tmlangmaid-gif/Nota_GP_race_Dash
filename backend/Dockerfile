# Backend image: FastAPI + Playwright Chromium.
# Use Playwright's official image — Chromium and all its system deps come baked in.
FROM mcr.microsoft.com/playwright/python:v1.49.1-noble

WORKDIR /app

# Copy and install Python deps first for better layer caching
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# App code
COPY backend ./backend
COPY frontend ./frontend

# Persistent data dir (used when DATABASE_URL points to SQLite; for Postgres this is unused)
ENV DATA_DIR=/data
RUN mkdir -p /data

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

# Fly.io will set $PORT; default 8000 for local docker run
CMD ["sh", "-c", "cd backend && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
