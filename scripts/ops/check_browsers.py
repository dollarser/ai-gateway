"""Run the shared portal browser gate without contacting production services."""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BROWSERS = (
    "browser_admin.py",
    "browser_password_reset.py",
    "browser_captcha.py",
    "browser_email_change.py",
)


def main():
    for name in BROWSERS:
        print("Browser gate: " + name, flush=True)
        subprocess.run(
            [sys.executable, str(ROOT / "tests" / name)], cwd=ROOT, check=True
        )


if __name__ == "__main__":
    main()
