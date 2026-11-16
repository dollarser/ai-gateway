"""Encrypted, authenticated migration snapshot of gateway, models and host credentials."""

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import sqlite3
import subprocess
import tarfile
from scripts.ops.restore_device import file_hmac
from scripts.ops.release import verify_backup

ROOT = Path(__file__).resolve().parents[2]
HOME = Path.home()


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    work = HOME / ".local/state/project-backups" / stamp
    work.mkdir(parents=True, mode=0o700)
    key = HOME / ".local/share/project-backup-keys" / (stamp + ".key")
    key.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with key.open("x") as stream:
        stream.write(secrets.token_urlsafe(64) + "\n")
    output = args.destination / stamp
    if output.exists():
        raise SystemExit("Backup destination already exists")
    models = ROOT.parent / "model-serving"
    if not models.is_dir():
        raise SystemExit("model-serving directory missing")
    env = os.environ.copy()
    env["PATH"] = str(HOME / ".local/tools/node/bin") + os.pathsep + env.get("PATH", "")
    with (ROOT / ".runtime/release.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        d1 = work / "d1.sql"
        with (work / "d1-export.log").open("w") as log:
            subprocess.run(
                [
                    str(ROOT / "cloudflare/node_modules/.bin/wrangler"),
                    "d1",
                    "export",
                    "DB",
                    "--remote",
                    "--config",
                    str(ROOT / "cloudflare/wrangler.jsonc"),
                    "--output",
                    str(d1),
                ],
                check=True,
                env=env,
                cwd=ROOT,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        verify_backup(d1)
        print("Fresh D1 export and restore integrity check passed", flush=True)
        local_db = ROOT / "accounts/data/accounts.db"
        snapshot = work / "accounts.db"
        if local_db.exists():
            with (
                sqlite3.connect(str(local_db)) as source,
                sqlite3.connect(str(snapshot)) as dest,
            ):
                source.backup(dest)
                assert dest.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        state = {
            "schema": "project-device-backup-v1",
            "created_utc": stamp,
            "source_home": str(HOME),
            "platform": platform.platform(),
            "gateway_commit": subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
            ).strip(),
            "gateway_status": subprocess.check_output(
                ["git", "status", "--porcelain"], cwd=ROOT, text=True
            ),
            "model_serving_git_status": subprocess.check_output(
                ["git", "status", "--porcelain"], cwd=models, text=True
            ),
            "model_serving_note": "Current public weights and GPU runtime environments are incomplete; restore existing deployment baseline, then provision missing resources.",
            "d1_export_sha256": sha256(d1),
            "cloud_state": "Existing Worker, D1, DNS and tunnel remain in Cloudflare; do not reimport D1 for a device-only migration.",
        }
        (work / "manifest.json").write_text(json.dumps(state, indent=2))
        archive = work / "projects.tar.gz"

        def filtered(member):
            parts = Path(member.name).parts
            if any(
                part in {"__pycache__", ".ruff_cache", ".pytest_cache"}
                for part in parts
            ):
                return None
            if parts[-1] in {
                "release.lock",
                "instance.lock",
                "accounts.db",
                "accounts.db-wal",
                "accounts.db-shm",
            }:
                return None
            return member

        with tarfile.open(archive, "w:gz", compresslevel=3, dereference=False) as tar:
            tar.add(ROOT.resolve(), arcname="projects/ai-gateway", filter=filtered)
            tar.add(models.resolve(), arcname="projects/model-serving", filter=filtered)
            tar.add(d1, arcname="database/d1-latest.sql")
            if snapshot.exists():
                tar.add(
                    snapshot, arcname="projects/ai-gateway/accounts/data/accounts.db"
                )
            for relative in [
                ".cloudflared",
                ".config/.wrangler",
                ".ssh/hij_pem_rsa",
                ".ssh/config",
                ".gitconfig",
                ".aws/config",
                ".aws/credentials",
                ".local/bin/cloudflared",
            ]:
                source = HOME / relative
                if source.exists():
                    tar.add(source, arcname="home/" + relative)
            units = HOME / ".config/systemd/user"
            for source in sorted(units.glob("ai-gateway*")):
                tar.add(source, arcname="home/.config/systemd/user/" + source.name)
            node = HOME / ".local/tools/node"
            if node.exists():
                tar.add(
                    node.resolve(), arcname="home/.local/tools/" + node.resolve().name
                )
                tar.add(node, arcname="home/.local/tools/node")
            tar.add(work / "manifest.json", arcname="manifest.json")
        print("Project and credential snapshot packed", flush=True)
    encrypted = work / "projects.tar.gz.enc"
    subprocess.run(
        [
            "openssl",
            "enc",
            "-aes-256-cbc",
            "-salt",
            "-pbkdf2",
            "-iter",
            "600000",
            "-md",
            "sha256",
            "-pass",
            "file:" + str(key),
            "-in",
            str(archive),
            "-out",
            str(encrypted),
        ],
        check=True,
    )
    signature = encrypted.with_suffix(encrypted.suffix + ".hmac")
    signature.write_text(file_hmac(encrypted, key.read_bytes()) + "\n")
    # Verify decryption without retaining another plaintext archive.
    verify = subprocess.Popen(
        [
            "openssl",
            "enc",
            "-d",
            "-aes-256-cbc",
            "-pbkdf2",
            "-iter",
            "600000",
            "-md",
            "sha256",
            "-pass",
            "file:" + str(key),
            "-in",
            str(encrypted),
        ],
        stdout=subprocess.PIPE,
    )
    digest = hashlib.sha256()
    for block in iter(lambda: verify.stdout.read(1024 * 1024), b""):
        digest.update(block)
    if verify.wait() != 0 or digest.hexdigest() != sha256(archive):
        raise RuntimeError("Decryption verification failed")
    output.mkdir(parents=True)
    for source in [
        encrypted,
        signature,
        ROOT / "scripts/ops/restore_device.py",
        ROOT / "docs/device-backup-restore.md",
    ]:
        destination = output / source.name
        with source.open("rb") as src, destination.open("xb") as dst:
            shutil.copyfileobj(src, dst, 8 * 1024 * 1024)
        if sha256(destination) != sha256(source):
            raise RuntimeError("S3 readback checksum mismatch: " + source.name)
    checksums = {
        p.name: sha256(p)
        for p in [
            encrypted,
            signature,
            ROOT / "scripts/ops/restore_device.py",
            ROOT / "docs/device-backup-restore.md",
        ]
    }
    receipt = {
        "created_utc": stamp,
        "bundle_bytes": encrypted.stat().st_size,
        "sha256": checksums,
        "s3_readback_verified": True,
    }
    (work / "backup-receipt.json").write_text(json.dumps(receipt, indent=2))
    # User requires off-machine recovery of credentials and the recovery key.
    recovery_dir = args.destination.parent / "project-backup-recovery"
    recovery_dir.mkdir(parents=True, exist_ok=True)
    remote_key = recovery_dir / key.name
    with key.open("rb") as src, remote_key.open("xb") as dst:
        shutil.copyfileobj(src, dst)
    if remote_key.read_bytes() != key.read_bytes():
        raise RuntimeError("Recovery key S3 readback mismatch")
    receipt["recovery_key_s3_path"] = str(remote_key)
    (output / "RECOVERY-KEY-LOCATION.txt").write_text(str(remote_key) + "\n")
    # Rewrite is avoided on Mountpoint S3: upload final receipt only once.

    (output / "backup-receipt.json").write_text(json.dumps(receipt, indent=2))
    (work / "backup-receipt.json").write_text(json.dumps(receipt, indent=2))
    archive.unlink()
    d1.unlink()
    if snapshot.exists():
        snapshot.unlink()
    print(
        json.dumps(
            {"backup_directory": str(output), "recovery_key": str(key), **receipt}
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
