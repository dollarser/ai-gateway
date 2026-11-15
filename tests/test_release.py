"""Release backup verification restores into memory and checks relationships."""

import tempfile
import unittest
from pathlib import Path
from scripts.ops.release import verify_backup


class ReleaseTests(unittest.TestCase):
    def test_restore_checks_foreign_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "backup.sql"
            path.write_text(
                "CREATE TABLE p(id INTEGER PRIMARY KEY);CREATE TABLE c(id INTEGER REFERENCES p(id));INSERT INTO p VALUES(1);INSERT INTO c VALUES(1);"
            )
            verify_backup(path)
            path.write_text(
                "CREATE TABLE p(id INTEGER PRIMARY KEY);CREATE TABLE c(id INTEGER REFERENCES p(id));INSERT INTO c VALUES(2);"
            )
            with self.assertRaisesRegex(RuntimeError, "integrity"):
                verify_backup(path)
