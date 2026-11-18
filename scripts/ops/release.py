"""Validated, logged release: checks -> private backup -> migration -> deploy -> smoke."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import shutil
import httpx
from contextlib import redirect_stdout
from scripts.ops.build_assets import build
from scripts.ops.release_checks import (
    retry,
    wait_for_release,
    verify_assets,
    pending_migrations,
    rehearse_migrations,
    restart_required,
)
from scripts.smoke.check_deployment import check as check_deployment
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]


def verify_backup(path):
    db = sqlite3.connect(":memory:")
    db.executescript(path.read_text())
    if (
        db.execute("PRAGMA integrity_check").fetchone()[0] != "ok"
        or db.execute("PRAGMA foreign_key_check").fetchall()
    ):
        raise RuntimeError("Backup restore integrity check failed")
    if (
        db.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('luna_spend_totals','audio_spend_totals')"
        ).fetchone()[0]
        == 2
    ):
        from scripts.ops.check_spend_totals import QUERY

        if db.execute(QUERY).fetchone()[0]:
            raise RuntimeError("Backup spend totals differ from detailed ledgers")
    if db.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='luna_user_month_totals'"
    ).fetchone()[0]:
        from scripts.ops.check_spend_totals import PERSONAL_QUERY

        if db.execute(PERSONAL_QUERY).fetchone()[0]:
            raise RuntimeError(
                "Backup personal cloud totals differ from detailed ledgers"
            )
    db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--deploy", action="store_true", help="Without this flag only checks run"
    )
    parser.add_argument("--openai-transport", choices=["worker", "local"])
    parser.add_argument(
        "--maintenance",
        action="store_true",
        help="Force maintenance even without pending migrations",
    )
    parser.add_argument(
        "--resume-maintenance",
        action="store_true",
        help="Explicitly continue a previous interrupted cutover",
    )
    parser.add_argument(
        "--restart-origin",
        action="store_true",
        help="Restart origin even if no runtime files changed",
    )
    parser.add_argument(
        "--browser-python", type=Path, default=ROOT / ".venv-dev/bin/python"
    )
    args = parser.parse_args()
    os.chdir(ROOT)
    os.umask(0o077)

    def assert_clean():
        if subprocess.check_output(["git", "status", "--porcelain"]):
            raise RuntimeError(
                "Commit changes before deployment so the release SHA is reviewable"
            )

    if args.deploy:
        assert_clean()
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    directory = (
        ROOT
        / ".runtime/releases"
        / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + sha[:12])
    )
    directory.mkdir(parents=True, mode=0o700)
    manifest = {
        "commit": sha,
        "status": "checking",
        "steps": [],
        "worker_version": None,
        "maintenance_active": False,
    }

    def save():
        (directory / "release.json").write_text(json.dumps(manifest, indent=2) + "\n")

    def run(name, command):
        manifest["active_step"] = name
        save()
        print(name + ": " + str(directory / (name + ".log")), flush=True)
        with (directory / (name + ".log")).open("w") as log:
            env = {
                k: v
                for k, v in os.environ.items()
                if not (
                    name.endswith("tests")
                    and (
                        k.startswith(("ACCOUNTS_", "GATEWAY_"))
                        or k.endswith("_UPSTREAM_URL")
                    )
                )
            }
            subprocess.run(
                command,
                check=True,
                stdout=log,
                stderr=subprocess.STDOUT,
                env={**env, "CI": "true"},
            )
        manifest["steps"].append(name)
        save()

    def stage(name, operation):
        manifest["active_step"] = name
        save()
        with (directory / (name + ".log")).open("w") as log, redirect_stdout(log):
            result = operation()
            if result is not None:
                print(json.dumps(result, indent=2))
        manifest["steps"].append(name)
        save()
        return result

    wrangler = [str(ROOT / "cloudflare/node_modules/.bin/wrangler")]
    config = ["--config", "cloudflare/wrangler.jsonc"]

    def deploy(maintenance, name):
        command = wrangler + [
            "deploy",
            "--tag",
            sha[:12] + ("-maint" if maintenance else ""),
            "--message",
            "release " + sha,
            "--var",
            "RELEASE_SHA:" + sha,
            "--var",
            "ACCOUNT_MAINTENANCE:" + str(maintenance).lower(),
        ]
        if args.openai_transport:
            command += ["--var", "OPENAI_TRANSPORT:" + args.openai_transport]
        run(name, command + config)
        match = re.search(
            r"Current Version ID:\s*([a-f0-9-]+)",
            (directory / (name + ".log")).read_text(),
        )
        manifest["maintenance_version" if maintenance else "worker_version"] = (
            match[1] if match else None
        )
        manifest["maintenance_active"] = maintenance
        save()

    origins = ("https://accounts.hilex.me", "https://api.hilex.me")
    maintenance_started = False
    normal_deploy_started = False
    with (ROOT / ".runtime/release.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            run("python-tests", [sys.executable, "-m", "tests.run"])
            run("worker-tests", ["npm", "--prefix", "cloudflare", "test"])
            browser_python = (
                args.browser_python
                if args.browser_python.exists()
                else Path(sys.executable)
            )
            run(
                "browser-tests",
                [str(browser_python), "-m", "scripts.ops.check_browsers"],
            )
            run("diff-check", ["git", "diff", "--check"])
            if not args.deploy:
                manifest["status"] = "checks_passed"
                return
            assert_clean()
            with httpx.Client(timeout=10, trust_env=False) as client:
                response = client.get(
                    origins[0] + "/healthz", headers={"Cache-Control": "no-cache"}
                )
                previous = response.json()
                previous_sha = previous.get("release")
                already_maintenance = previous.get("error_code") == "maintenance"
                if (
                    already_maintenance
                    and previous_sha != sha
                    and not args.resume_maintenance
                ):
                    raise RuntimeError(
                        "Another cutover is in maintenance; inspect its release record and use --resume-maintenance explicitly"
                    )
                manifest["previous_commit"] = previous_sha
                save()
                preflight = directory / "preflight.sql"
                run(
                    "backup-preflight",
                    wrangler
                    + ["d1", "export", "DB", "--remote", "--output", str(preflight)]
                    + config,
                )
                verify_backup(preflight)
                pending = pending_migrations(preflight, ROOT / "cloudflare/migrations")
                manifest["pending_migrations"] = [path.name for path in pending]
                stage(
                    "migration-rehearsal",
                    lambda: rehearse_migrations(preflight, pending),
                )
                keep_previous = (
                    previous_sha
                    if previous_sha
                    and subprocess.run(
                        ["git", "cat-file", "-e", previous_sha + "^{commit}"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    ).returncode
                    == 0
                    else None
                )
                manifest["previous_assets_retained"] = bool(keep_previous)
                stage("build-assets", lambda: str(build(previous_ref=keep_previous)))
                required = args.maintenance or bool(pending) or already_maintenance
                manifest["maintenance_required"] = required
                save()
                backup = directory / "d1.sql"
                if required:
                    maintenance_started = True
                    deploy(True, "maintenance-enable")
                    stage(
                        "maintenance-check",
                        lambda: wait_for_release(
                            client, origins, sha, maintenance=True
                        ),
                    )
                    run(
                        "backup",
                        wrangler
                        + ["d1", "export", "DB", "--remote", "--output", str(backup)]
                        + config,
                    )
                    verify_backup(backup)
                    stage(
                        "cutover-rehearsal",
                        lambda: rehearse_migrations(backup, pending),
                    )
                else:
                    shutil.copyfile(preflight, backup)
                if pending:
                    manifest["status"] = "migrating"
                    save()
                    run(
                        "migrations",
                        wrangler
                        + ["d1", "migrations", "apply", "DB", "--remote"]
                        + config,
                    )
                run(
                    "spend-reconciliation",
                    [
                        sys.executable,
                        "-m",
                        "scripts.ops.check_spend_totals",
                        "--remote",
                    ],
                )
                manifest["status"] = "migrated"
                save()
                manifest["origin_restart_required"] = restart_required(
                    ROOT, previous_sha, force=args.restart_origin
                )
                if manifest["origin_restart_required"]:
                    run(
                        "origin-restart",
                        ["systemctl", "--user", "restart", "ai-gateway.service"],
                    )

                def origin_ready():
                    r = client.get("http://127.0.0.1:18900/healthz", timeout=3)
                    if r.status_code != 200 or r.json().get("ready") is not True:
                        raise RuntimeError("Protected origin is not ready")

                stage("origin-check", lambda: retry(origin_ready))
                assert_clean()
                normal_deploy_started = True
                deploy(False, "deploy")
                manifest["openai_transport_override"] = args.openai_transport
                stage(
                    "release-propagation-check",
                    lambda: wait_for_release(client, origins, sha),
                )
                stage(
                    "asset-propagation-check",
                    lambda: retry(
                        lambda: verify_assets(
                            client, origins[0], ROOT / ".runtime/portal-assets"
                        )
                    ),
                )
                stage(
                    "deployment-check",
                    lambda: retry(lambda: check_deployment(client, *origins)),
                )
                manifest["status"] = "deployed_and_verified"
                manifest["active_step"] = None
        except BaseException:
            manifest["status"] = "failed"
            manifest["failed_step"] = manifest.get("active_step")
            save()
            if maintenance_started and normal_deploy_started:
                try:
                    deploy(True, "maintenance-recovery")
                except BaseException:
                    manifest["maintenance_active"] = "unknown"
            print(
                "Release stopped; inspect private logs. Never restore D1 over live data or deploy old SQL after a schema cutover.",
                file=sys.stderr,
            )
            raise
        finally:
            save()
            print("Release record: " + str(directory / "release.json"), flush=True)


if __name__ == "__main__":
    main()
