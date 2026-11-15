"""Import legacy key hashes, permissions and quota baseline; run only with gateways stopped."""

import argparse
import json
import os
import secrets
import sqlite3
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from accounts.store import Store, password_hash

ROOT = Path(__file__).resolve().parents[2]


def migrate(source, target, backup):
    os.umask(0o077)
    backup.mkdir(parents=True, exist_ok=True)
    source_db = sqlite3.connect("file:" + str(source) + "?mode=ro", uri=True)
    source_db.row_factory = sqlite3.Row
    target_db = sqlite3.connect(str(target))
    if target_db.execute(
        "SELECT count(*) FROM requests WHERE ended IS NULL"
    ).fetchone()[0]:
        raise RuntimeError("Account gateway has active leases")
    for connection, name in [(source_db, "legacy.db"), (target_db, "accounts.db")]:
        dest = sqlite3.connect(str(backup / name))
        connection.backup(dest)
        dest.close()
        os.chmod(backup / name, 0o600)
    target_db.close()
    store = Store(target)
    usage = defaultdict(lambda: [0, 0])
    for row in source_db.execute(
        "SELECT key_id,ts,prompt_tokens,completion_tokens FROM usage_log"
    ):
        day = (
            datetime.strptime(row["ts"], "%Y-%m-%d %H:%M:%S")
            .replace(tzinfo=timezone.utc)
            .astimezone(ZoneInfo("Asia/Shanghai"))
            .date()
            .isoformat()
        )
        usage[(row["key_id"], day)][0] += row["prompt_tokens"] or 0
        usage[(row["key_id"], day)][1] += row["completion_tokens"] or 0
    imported = skipped = 0
    with store.transaction() as db:
        manager = db.execute(
            "SELECT id FROM users WHERE role='admin' AND enabled=1 ORDER BY id LIMIT 1"
        ).fetchone()
        if not manager:
            raise RuntimeError("No active administrator")
        for old in source_db.execute("SELECT * FROM api_keys ORDER BY id"):
            present = db.execute(
                "SELECT id FROM keys WHERE hash=?", (old["key_hash"],)
            ).fetchone()
            if present:
                skipped += 1
                continue
            username = f"legacy-api-key-{old['id']}"
            if db.execute(
                "SELECT id FROM users WHERE username=?", (username,)
            ).fetchone():
                raise RuntimeError("Legacy account name conflict")
            user = db.execute(
                """INSERT INTO users(username,password,role,enabled,services,rpm,daily_requests,concurrency,must_change,created)
                VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (
                    username,
                    password_hash(secrets.token_urlsafe(48)),
                    "user",
                    1,
                    json.dumps(["qwen"]),
                    old["rpm_limit"] if old["rpm_limit"] > 0 else 1000000000,
                    1000000000,
                    old["max_concurrent"],
                    0,
                    time.time(),
                ),
            ).lastrowid
            expires = (
                datetime.strptime(old["expires_at"], "%Y-%m-%d %H:%M:%S")
                .replace(tzinfo=timezone.utc)
                .timestamp()
                if old["expires_at"]
                else 253402214400.0
            )
            kid = db.execute(
                """INSERT INTO keys(user_id,name,hash,prefix,services,expires,revoked,created,legacy_daily_tokens)
                VALUES(?,?,?,?,?,?,?,?,?)""",
                (
                    user,
                    old["name"],
                    old["key_hash"],
                    old["key_prefix"],
                    json.dumps(["qwen"]),
                    expires,
                    old["revoked"],
                    time.time(),
                    old["daily_tokens"],
                ),
            ).lastrowid
            for (oldid, day), (pt, ct) in usage.items():
                if oldid == old["id"]:
                    db.execute(
                        "INSERT INTO legacy_token_baseline VALUES(?,?,?,?)",
                        (kid, day, pt, ct),
                    )
            store.audit(db, manager["id"], "migrate_legacy_api_key", kid)
            imported += 1
    store.db.close()
    source_db.close()
    return {
        "imported_keys": imported,
        "already_present": skipped,
        "backup_directory": str(backup),
        "quota_day": "Asia/Shanghai",
        "source_timestamp_timezone": "UTC",
        "raw_keys_read_or_written": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--source", type=Path, required=True, help="Legacy gateway database to import"
    )
    args = parser.parse_args()
    if not args.apply:
        parser.error("Use --apply only after stopping both gateways")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    result = migrate(
        args.source,
        ROOT / "accounts/data/accounts.db",
        ROOT / "accounts/data/migration-backups" / stamp,
    )
    (ROOT / "artifacts/gateway-migration.json").write_text(
        json.dumps(result, indent=2) + "\n"
    )
    print(json.dumps(result, indent=2))
