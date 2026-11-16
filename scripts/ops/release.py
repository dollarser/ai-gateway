"""Validated, logged release: checks -> private backup -> migration -> deploy -> smoke."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
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
    db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--deploy", action="store_true", help="Without this flag only checks run"
    )
    parser.add_argument(
        "--openai-transport",
        choices=["worker", "local"],
        help="Override OpenAI egress route for this deployment",
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
    }

    def save():
        (directory / "release.json").write_text(json.dumps(manifest, indent=2))

    def run(name, command):
        print(name + ": " + str(directory / (name + ".log")), flush=True)
        with (directory / (name + ".log")).open("w") as log:
            subprocess.run(
                command,
                check=True,
                stdout=log,
                stderr=subprocess.STDOUT,
                env={
                    **{
                        k: v
                        for k, v in os.environ.items()
                        if not (
                            name.endswith("tests")
                            and (
                                k.startswith(("ACCOUNTS_", "GATEWAY_"))
                                or k.endswith("_UPSTREAM_URL")
                            )
                        )
                    },
                    "CI": "true",
                },
            )
        manifest["steps"].append(name)
        save()

    with (ROOT / ".runtime/release.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            run("python-tests", [sys.executable, "-m", "tests.run"])
            run("worker-tests", ["npm", "--prefix", "cloudflare", "test"])
            run("diff-check", ["git", "diff", "--check"])
            if not args.deploy:
                manifest["status"] = "checks_passed"
                return
            assert_clean()
            wrangler = [str(ROOT / "cloudflare/node_modules/.bin/wrangler")]
            config = ["--config", "cloudflare/wrangler.jsonc"]
            backup = directory / "d1.sql"
            run(
                "backup",
                wrangler
                + ["d1", "export", "DB", "--remote", "--output", str(backup)]
                + config,
            )
            verify_backup(backup)
            run(
                "migrations",
                wrangler + ["d1", "migrations", "apply", "DB", "--remote"] + config,
            )
            run(
                "spend-reconciliation",
                [sys.executable, "-m", "scripts.ops.check_spend_totals", "--remote"],
            )
            manifest["status"] = "migrated"
            save()
            run(
                "origin-restart",
                ["systemctl", "--user", "restart", "ai-gateway.service"],
            )
            import httpx
            import time

            for attempt in range(10):
                try:
                    ready = httpx.get(
                        "http://127.0.0.1:18900/healthz", timeout=2, trust_env=False
                    )
                    ready.raise_for_status()
                    if ready.json().get("ready") is True:
                        break
                except (httpx.HTTPError, ValueError):
                    pass
                time.sleep(0.5)
            else:
                raise RuntimeError("Protected origin did not become ready")
            assert_clean()
            run(
                "deploy",
                wrangler
                + [
                    "deploy",
                    "--tag",
                    sha[:12],
                    "--message",
                    "release " + sha,
                    "--var",
                    "RELEASE_SHA:" + sha,
                ]
                + (
                    ["--var", "OPENAI_TRANSPORT:" + args.openai_transport]
                    if args.openai_transport
                    else []
                )
                + config,
            )
            manifest["openai_transport_override"] = args.openai_transport
            match = re.search(
                r"Current Version ID:\s*([a-f0-9-]+)",
                (directory / "deploy.log").read_text(),
            )
            manifest["worker_version"] = match[1] if match else None
            run(
                "deployment-check",
                [sys.executable, "-m", "scripts.smoke.check_deployment"],
            )
            for host in ("accounts", "api"):
                for attempt in range(5):
                    response = httpx.get(
                        "https://" + host + ".hilex.me/healthz",
                        timeout=15,
                        trust_env=False,
                        headers={"Cache-Control": "no-cache"},
                    )
                    response.raise_for_status()
                    if response.json().get("release") == sha:
                        break
                    if attempt == 4:
                        raise RuntimeError(
                            "Public release SHA mismatch after propagation retries"
                        )
                    time.sleep(2)
            manifest["status"] = "deployed_and_verified"
        except BaseException:
            manifest["status"] = "failed"
            print(
                "Release stopped; inspect private logs and release.json. Do not restore D1 over live data.",
                file=sys.stderr,
            )
            raise
        finally:
            save()
            print("Release record: " + str(directory / "release.json"), flush=True)


if __name__ == "__main__":
    main()
