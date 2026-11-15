"""Export a consistent account snapshot for an empty D1 database (no cloud writes)."""

import argparse
import os
from pathlib import Path
import sqlite3
import time

ORDER = [
    "users",
    "keys",
    "settings",
    "auth_families",
    "access_tokens",
    "refresh_tokens",
    "sessions",
    "requests",
    "legacy_token_baseline",
    "audit",
    "login_attempts",
    "registration_attempts",
    "inference_auth_failures",
]
ROOT = Path(__file__).resolve().parents[2]


def export(source, output):
    original = sqlite3.connect("file:" + str(source.resolve()) + "?mode=ro", uri=True)
    snapshot = sqlite3.connect(":memory:")
    original.backup(snapshot)
    original.close()
    assert snapshot.execute("pragma quick_check").fetchone() == ("ok",)
    schema = (ROOT / "cloudflare/migrations/0001_accounts.sql").read_text()
    ddl, *triggers = schema.split("CREATE TRIGGER")
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    counts = {}
    with os.fdopen(fd, "w") as out:
        out.write(
            "-- Sensitive account snapshot. Import into a NEW empty D1 database only.\nPRAGMA defer_foreign_keys=ON;\n"
        )
        # The quota trigger must not reject historical requests while importing.
        out.write(
            "DROP TRIGGER IF EXISTS request_quota;\nDROP TRIGGER IF EXISTS protect_last_admin;\n"
        )
        existing = {
            r[0]
            for r in snapshot.execute(
                "select name from sqlite_master where type='table'"
            )
        }
        for table in ORDER:
            if table not in existing:
                continue
            columns = [
                r[1] for r in snapshot.execute('pragma table_info("' + table + '")')
            ]
            counts[table] = 0
            for row in snapshot.execute('select * from "' + table + '"'):
                # quote() handles SQL strings, NULL and blobs without shell interpolation.
                values = []
                for col, value in zip(columns, row):
                    if table == "requests" and col == "ended" and value is None:
                        value = time.time()
                    if table == "requests" and col == "status" and value is None:
                        value = 503
                    values.append(
                        snapshot.execute("select quote(?)", (value,)).fetchone()[0]
                    )
                command = "INSERT OR REPLACE" if table == "settings" else "INSERT"
                out.write(
                    command
                    + ' INTO "'
                    + table
                    + '" ('
                    + ",".join('"' + c + '"' for c in columns)
                    + ") VALUES("
                    + ",".join(values)
                    + ");\n"
                )
                counts[table] += 1
        for trigger in triggers:
            out.write("CREATE TRIGGER" + trigger + "\n")
        out.write("PRAGMA defer_foreign_keys=OFF;\n")
    snapshot.close()
    return counts


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", type=Path, required=True, help="Explicit local SQLite snapshot; this does not read production D1")
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    counts = export(a.source, a.output)
    print("Sensitive D1 import saved with mode 600. Table counts:", counts)
