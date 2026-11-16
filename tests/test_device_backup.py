"""Restore verifies authentication and refuses overwrites before extraction."""

import io
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from scripts.ops.restore_device import restore, file_hmac


class DeviceBackupTests(unittest.TestCase):
    def fixture(self, root):
        key = root / "recovery.key"
        key.write_text("test-only-not-a-production-key\n")
        archive = root / "test.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            item = tarfile.TarInfo("projects/config.txt")
            item.size = 7
            tar.addfile(item, io.BytesIO(b"private"))
        bundle = root / "test.tar.gz.enc"
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
                str(bundle),
            ],
            check=True,
        )
        bundle.with_suffix(".enc.hmac").write_text(file_hmac(bundle, key.read_bytes()))
        return key, bundle

    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            key, bundle = self.fixture(root)
            destination = root / "restored"
            restore(bundle, key, destination)
            self.assertEqual(
                (destination / "projects/config.txt").read_bytes(), b"private"
            )

    def test_wrong_key_tampering_and_overwrite_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            key, bundle = self.fixture(root)
            wrong = root / "wrong.key"
            wrong.write_text("wrong")
            with self.assertRaises(SystemExit):
                restore(bundle, wrong, root / "restored")
            self.assertFalse((root / "restored").exists())
            existing = root / "existing"
            existing.mkdir()
            with self.assertRaises(SystemExit):
                restore(bundle, key, existing)
            data = bytearray(bundle.read_bytes())
            data[-1] ^= 1
            bundle.write_bytes(data)
            with self.assertRaises(SystemExit):
                restore(bundle, key, root / "restored")
            self.assertFalse((root / "restored").exists())
