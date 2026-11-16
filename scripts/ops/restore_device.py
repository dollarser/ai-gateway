"""Authenticate and extract an encrypted device backup without starting services."""

import argparse
import hashlib
import hmac
from pathlib import Path
import subprocess
import tarfile
import tempfile


def file_hmac(path, password):
    key = hashlib.sha256(b"project-backup-hmac-v1\0" + password.strip()).digest()
    digest = hmac.new(key, digestmod="sha256")
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def restore(bundle, key, destination):
    if destination.exists():
        raise SystemExit(
            "Destination must not exist; existing files are never overwritten"
        )
    expected = bundle.with_suffix(bundle.suffix + ".hmac").read_text().strip()
    if not hmac.compare_digest(file_hmac(bundle, key.read_bytes()), expected):
        raise SystemExit(
            "Backup authentication failed; wrong recovery key or damaged backup"
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="restore-", dir=destination.parent) as temp:
        private = Path(temp)
        archive = private / "backup.tar.gz"
        subprocess.run(
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
                "file:" + str(key.resolve()),
                "-in",
                str(bundle.resolve()),
                "-out",
                str(archive),
            ],
            check=True,
        )
        extracted = private / "files"
        extracted.mkdir(mode=0o700)
        with tarfile.open(archive, "r:gz") as tar:
            members = tar.getmembers()
            links = {m.name.rstrip("/") for m in members if m.issym()}
            for member in members:
                path = Path(member.name)
                if (
                    path.is_absolute()
                    or ".." in path.parts
                    or member.isdev()
                    or member.isfifo()
                ):
                    raise SystemExit("Unsafe backup member")
                if any(str(parent) in links for parent in path.parents):
                    raise SystemExit("Backup writes through a symbolic link")
                if member.islnk():
                    target = Path(member.linkname)
                    if target.is_absolute() or ".." in target.parts:
                        raise SystemExit("Unsafe hard link")
            # Authenticated archive intentionally preserves venv absolute symlinks.
            tar.extractall(extracted, members=members, filter="fully_trusted")
        extracted.rename(destination)
    print("Backup verified and extracted to " + str(destination))
    print("No credentials installed, databases imported or services started.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    restore(args.bundle, args.key, args.destination)


if __name__ == "__main__":
    main()
