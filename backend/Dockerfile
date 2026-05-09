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

# Drop root inside the container — limits blast radius if anything in the
# backend ends up code-execing. The Playwright base image already ships a
# non-root `pwuser` that has access to its bundled Chromium browsers, so we
# just chown the app + data dirs to it and switch.
RUN chown -R pwuser:pwuser /app /data
USER pwuser

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

# Fly.io will set $PORT; default 8000 for local docker run
CMD ["sh", "-c", "cd backend && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
