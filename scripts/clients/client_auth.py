"""Read configured Client ID without putting it in command-line arguments."""

import inspect
import json
import os
from pathlib import Path


def client_id():
    value = os.environ.get("SPEECH_CLIENT_ID")
    if value:
        return value
    path = Path(
        os.environ.get(
            "SPEECH_CLIENT_IDS_FILE",
            str(Path(__file__).resolve().parents[2] / "deploy/client_ids.json"),
        )
    )
    return json.loads(path.read_text())[0]


def websocket_auth(connect):
    key = (
        "additional_headers"
        if "additional_headers" in inspect.signature(connect).parameters
        else "extra_headers"
    )
    api_key = (
        os.environ.get("AI_ACCESS_TOKEN")
        or os.environ.get("SPEECH_ACCESS_TOKEN")
        or os.environ.get("AI_API_KEY")
        or os.environ.get("SPEECH_API_KEY")
    )
    if not api_key:
        raise ValueError(
            "Set AI_ACCESS_TOKEN (login token) or an administrator API Key"
        )
    headers = {"Authorization": "Bearer " + api_key}
    if api_key.startswith("ai-at-"):
        headers["X-Client-ID"] = client_id()
    return {key: headers, "user_agent_header": "speech-client/1.0"}
