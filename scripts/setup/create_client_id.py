"""Create an initial local client ID; preserve an existing allowlist."""

import json
import os
import secrets
from pathlib import Path

path = Path(__file__).resolve().parents[2] / "deploy/client_ids.json"
path.parent.mkdir(parents=True, exist_ok=True)
try:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    print("Existing Client ID configuration retained")
else:
    with os.fdopen(descriptor, "w") as stream:
        json.dump(["speech-" + secrets.token_urlsafe(24)], stream)
    print("Created deploy/client_ids.json (mode 600)")
