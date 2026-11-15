"""Local recovery/bootstrap CLI. Output contains no credentials."""

import argparse
import json
import os
import secrets
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from accounts.store import password_hash

parser = argparse.ArgumentParser()
parser.add_argument("command", choices=["bootstrap", "create-user", "disable-user"])
parser.add_argument("--username", default="admin")
parser.add_argument("--output", type=Path)
args = parser.parse_args()
os.umask(0o077)
data = ROOT / "accounts/data"
data.mkdir(exist_ok=True, mode=0o700)
if args.command == "bootstrap":
    path = data / "bootstrap-admin.json"
    if path.exists():
        print("Existing bootstrap credentials retained")
    else:
        with path.open("x") as f:
            json.dump(
                {"username": args.username, "password": secrets.token_urlsafe(24)}, f
            )
        print("Bootstrap credentials saved to accounts/data/bootstrap-admin.json (600)")
else:
    db = sqlite3.connect(data / "accounts.db", timeout=5)
    if args.command == "disable-user":
        row = db.execute(
            "SELECT id,role FROM users WHERE username=?", (args.username,)
        ).fetchone()
        if not row:
            raise SystemExit("User does not exist")
        if row[1] == "admin":
            raise SystemExit("Use the portal for administrator account changes")
        db.execute("UPDATE users SET enabled=0 WHERE id=?", (row[0],))
        db.execute("DELETE FROM sessions WHERE user_id=?", (row[0],))
        if db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='auth_families'"
        ).fetchone():
            db.execute("UPDATE auth_families SET revoked=1 WHERE user_id=?", (row[0],))
        db.execute("UPDATE keys SET revoked=1 WHERE user_id=?", (row[0],))
        db.commit()
        print("User disabled, sessions and API keys revoked")
    else:
        import re
        import time

        if not re.fullmatch(r"[a-zA-Z0-9_.-]{3,64}", args.username):
            raise SystemExit("Invalid username")
        if not args.output:
            raise SystemExit("--output is required for initial credentials")
        password = secrets.token_urlsafe(24)
        # Exclusive output prevents overwriting a previously delivered credential file.
        with args.output.open("x") as out:
            try:
                db.execute(
                    """INSERT INTO users(username,password,role,enabled,services,rpm,daily_requests,
     concurrency,must_change,created) VALUES(?,?,'user',1,?,30,1000,2,1,?)""",
                    (
                        args.username.lower(),
                        password_hash(password),
                        json.dumps(["qwen", "asr", "tts"]),
                        time.time(),
                    ),
                )
                db.commit()
            except BaseException:
                args.output.unlink(missing_ok=True)
                raise
            json.dump({"username": args.username.lower(), "password": password}, out)
        print("User created; initial credentials saved to protected output file")
    db.close()
