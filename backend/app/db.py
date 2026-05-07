import os
from pathlib import Path
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker, declarative_base

DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parents[2] / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "race.db"

DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DB_PATH}")

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def ensure_column(table: str, column: str, ddl_type: str, on_add=None) -> bool:
    """Add a column to an existing table if it doesn't already exist.

    SQLAlchemy's `create_all` creates new tables but never alters existing ones,
    so we add new columns with a tiny manual migration. Works on SQLite and
    Postgres because both support `ALTER TABLE ... ADD COLUMN <name> <type>`.

    If `on_add` is provided, it's called once *after* the column was actually
    added — useful for one-shot back-fill steps (e.g. grandfathering existing
    rows). Returns True if the column was added, False if it already existed.
    """
    insp = inspect(engine)
    if not insp.has_table(table):
        return False
    existing = {c["name"] for c in insp.get_columns(table)}
    if column in existing:
        return False
    with engine.begin() as conn:
        conn.exec_driver_sql(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {ddl_type}')
    if on_add:
        on_add()
    return True
