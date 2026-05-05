"""Admin tool: reset a user's password directly in the DB.

For when you've forgotten your password and the proper /forgot-password flow
isn't built yet (or isn't reachable). Run inside the running backend container.

Usage:
    docker exec racedash-backend python /app/backend/reset_password.py EMAIL NEW_PASSWORD

Examples:
    docker exec racedash-backend python /app/backend/reset_password.py me@example.com newpass1234
"""

import sys
from pathlib import Path

# Make `app.*` importable when run as `python backend/reset_password.py`.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import bcrypt
from app.db import SessionLocal
from app.models import User


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2

    email = sys.argv[1].strip().lower()
    new_password = sys.argv[2]

    if len(new_password) < 8:
        print("Password must be at least 8 characters.", file=sys.stderr)
        return 1

    with SessionLocal() as db:
        user = db.query(User).filter(User.email == email).one_or_none()
        if not user:
            print(f"No user with email {email!r}.", file=sys.stderr)
            return 1
        user.password_hash = hash_password(new_password)
        db.commit()
        print(f"OK — password reset for {user.email}.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
