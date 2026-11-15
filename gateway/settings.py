"""Gateway configuration; inference backends are independent HTTP services."""

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def upstream(name, default):
    value = os.environ.get(name, default).rstrip("/")
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(f"{name} must be an HTTP(S) origin without a path")
    return value


@dataclass(frozen=True)
class Settings:
    data_dir: Path = field(
        default_factory=lambda: Path(
            os.environ.get("ACCOUNTS_DATA", ROOT / "accounts/data")
        )
    )
    client_ids_file: Path = field(
        default_factory=lambda: Path(
            os.environ.get("GATEWAY_CLIENT_IDS_FILE", ROOT / "deploy/client_ids.json")
        )
    )
    portal_host: str = field(
        default_factory=lambda: os.environ.get(
            "ACCOUNTS_HOST", "accounts.sunlingzhang.com"
        )
    )
    api_host: str = field(
        default_factory=lambda: os.environ.get(
            "GATEWAY_API_HOST", "api.sunlingzhang.com"
        )
    )
    accounts_worker_url: str = field(
        default_factory=lambda: os.environ.get("ACCOUNTS_WORKER_URL", "")
    )
    accounts_worker_secret: str = field(
        default_factory=lambda: os.environ.get("ACCOUNTS_WORKER_SECRET", ""), repr=False
    )
    bind_host: str = "127.0.0.1"
    public_port: int = 18900
    local_port: int = 18901
    llm_concurrency: int = field(
        default_factory=lambda: int(os.environ.get("GATEWAY_LLM_CONCURRENCY", "4"))
    )
    llm_url: str = field(
        default_factory=lambda: upstream("LLM_UPSTREAM_URL", "http://127.0.0.1:30007")
    )
    asr_url: str = field(
        default_factory=lambda: upstream("ASR_UPSTREAM_URL", "http://127.0.0.1:18767")
    )
    tts_url: str = field(
        default_factory=lambda: upstream("TTS_UPSTREAM_URL", "http://127.0.0.1:18768")
    )
    embedding_url: str = field(
        default_factory=lambda: upstream(
            "EMBEDDING_UPSTREAM_URL", "http://127.0.0.1:18771"
        )
    )
    vibevoice_url: str = field(
        default_factory=lambda: upstream(
            "VIBEVOICE_UPSTREAM_URL", "http://127.0.0.1:18769"
        )
    )


settings = Settings()
