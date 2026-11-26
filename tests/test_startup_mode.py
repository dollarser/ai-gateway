import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from gateway import run


class StartupModeTests(unittest.TestCase):
    def test_unconfigured_server_cannot_fall_back_to_sqlite(self):
        with (
            patch.object(
                run,
                "settings",
                SimpleNamespace(
                    accounts_worker_url="", accounts_worker_secret="", public_port=18900
                ),
            ),
            patch.object(sys, "argv", ["gateway.run"]),
            patch.object(run.socket, "socket") as sock,
        ):
            with self.assertRaises(SystemExit) as error:
                run.main()
            self.assertEqual(error.exception.code, 2)
            sock.assert_not_called()

    def test_retired_sqlite_flag_is_rejected(self):
        with (
            patch.object(
                run,
                "settings",
                SimpleNamespace(
                    accounts_worker_url="https://accounts.hilex.me",
                    accounts_worker_secret="x" * 40,
                    public_port=18900,
                ),
            ),
            patch.object(sys, "argv", ["gateway.run", "--local-accounts"]),
            patch.object(run.socket, "socket") as sock,
        ):
            with self.assertRaises(SystemExit):
                run.main()
            sock.assert_not_called()
