"""Run account and API gateway regressions; no model environments required."""

import unittest
from pathlib import Path

if __name__ == "__main__":
    suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent))
    raise SystemExit(
        not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
    )
