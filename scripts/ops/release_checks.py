"""Bounded propagation checks and offline migration rehearsal for releases."""

import hashlib
import re
import sqlite3
import subprocess
import time
from pathlib import Path

import httpx

ASSET_RE = re.compile(r"/static/[A-Za-z0-9_.-]+\.(?:js|css)")


def retry(check, *, attempts=16, sleep=time.sleep):
    last = None
    for attempt in range(attempts):
        try:
            return check()
        except (httpx.HTTPError, RuntimeError, ValueError) as error:
            last = error
            if attempt + 1 < attempts:
                sleep(min(1.5**attempt, 5))
    raise RuntimeError(f"Release verification did not converge: {last}") from last


def wait_for_release(
    client, origins, sha, *, maintenance=False, attempts=16, sleep=time.sleep
):
    def check():
        for origin in origins:
            response = client.get(
                origin + "/healthz", headers={"Cache-Control": "no-cache"}, timeout=5
            )
            body = response.json()
            expected_status = 503 if maintenance else 200
            if response.status_code != expected_status or body.get("release") != sha:
                raise RuntimeError(
                    "Expected release has not reached every checked endpoint"
                )
            if maintenance:
                if body.get("error_code") != "maintenance":
                    raise RuntimeError("Maintenance is not active")
            elif body.get("ready") is not True:
                raise RuntimeError("Release is not ready")
        return True

    retry(check, attempts=attempts, sleep=sleep)


def verify_assets(client, origin, directory):
    directory = Path(directory)
    for remote, local in [
        ("/", "index.html"),
        ("/auth/captcha?action=password_reset_code", "captcha.html"),
    ]:
        response = client.get(
            origin + remote, headers={"Cache-Control": "no-cache"}, timeout=5
        )
        if response.status_code != 200 or set(ASSET_RE.findall(response.text)) != set(
            ASSET_RE.findall((directory / local).read_text())
        ):
            raise RuntimeError(
                "Public portal HTML still references another asset version"
            )
    references = set()
    for page in ["index.html", "captcha.html", "admin/index.html"]:
        references.update(ASSET_RE.findall((directory / page).read_text()))
    for path in sorted(references):
        response = client.get(origin + path, timeout=5)
        expected = (directory / path.lstrip("/")).read_bytes()
        if (
            response.status_code != 200
            or hashlib.sha256(response.content).digest()
            != hashlib.sha256(expected).digest()
        ):
            raise RuntimeError("Published static asset is not ready: " + path)
    return len(references)


def pending_migrations(backup, directory):
    db = sqlite3.connect(":memory:")
    try:
        db.executescript(Path(backup).read_text())
        exists = db.execute(
            "SELECT 1 FROM sqlite_master WHERE name='d1_migrations'"
        ).fetchone()
        applied = (
            {row[0] for row in db.execute("SELECT name FROM d1_migrations")}
            if exists
            else set()
        )
        return [
            path
            for path in sorted(Path(directory).glob("*.sql"))
            if path.name not in applied
        ]
    finally:
        db.close()


def rehearse_migrations(backup, migrations):
    db = sqlite3.connect(":memory:")
    try:
        db.executescript(Path(backup).read_text())
        db.execute("PRAGMA foreign_keys=ON")
        tables = {
            row[0]
            for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        protected = {}
        for table, columns in [
            ("users", "id"),
            ("keys", "id"),
            ("customer_notice_reads", "notice_id,user_id"),
        ]:
            if table in tables:
                protected[(table, columns)] = set(
                    db.execute(f"SELECT {columns} FROM {table}")
                )
        if migrations:
            db.executescript(
                "BEGIN;\n"
                + "\n".join(Path(path).read_text() for path in migrations)
                + "\nCOMMIT;"
            )
        if (
            db.execute("PRAGMA integrity_check").fetchone()[0] != "ok"
            or db.execute("PRAGMA foreign_key_check").fetchall()
        ):
            raise RuntimeError(
                "Migration rehearsal failed integrity/foreign-key checks"
            )
        for (table, columns), before in protected.items():
            if not before.issubset(set(db.execute(f"SELECT {columns} FROM {table}"))):
                raise RuntimeError(
                    "Migration would remove protected account data: " + table
                )
        from scripts.ops.check_spend_totals import QUERY, PERSONAL_QUERY

        for name, query in [
            ("luna_spend_totals", QUERY),
            ("luna_user_month_totals", PERSONAL_QUERY),
        ]:
            if name in tables and db.execute(query).fetchone()[0]:
                raise RuntimeError("Migration rehearsal changed ledger consistency")
        return {
            "migrations": [Path(path).name for path in migrations],
            "protected_rows": sum(len(rows) for rows in protected.values()),
        }
    finally:
        db.close()


def restart_required(root, previous_sha, *, force=False):
    if force or not previous_sha:
        return True
    try:
        files = subprocess.check_output(
            ["git", "diff", "--name-only", previous_sha, "HEAD"],
            cwd=root,
            text=True,
            stderr=subprocess.DEVNULL,
        ).splitlines()
    except subprocess.CalledProcessError:
        return True
    prefixes = (
        "gateway/",
        "requirements/gateway.lock",
        "pyproject.toml",
        "scripts/ops/serve-gateway.sh",
        "deploy/systemd/",
    )
    return any(path.startswith(prefixes) for path in files)
