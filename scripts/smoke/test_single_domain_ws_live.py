"""Verify canonical ASR/TTS WS protocols with a temporary logged-in account."""

import asyncio
import json
import secrets
import sys
import time
import wave
from pathlib import Path
import httpx
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from accounts.store import Store

ROOT = Path(__file__).resolve().parents[2]
store = Store(ROOT / "accounts/data/accounts.db", recover_leases=False)
primary = next(u for u in store.users() if u["role"] == "admin" and u["enabled"])
username = "domain-ws-" + str(int(time.time()))
password = secrets.token_urlsafe(24)
user = store.create_user(username, password, must_change=False, actor=primary["id"])
result = {}
try:
    with httpx.Client(trust_env=False, timeout=60) as c:
        r = c.post(
            "https://accounts.hilex.me/auth/login",
            json={"username": username, "password": password},
        )
        r.raise_for_status()
        tokens = r.json()
        c.cookies.clear()
        headers = {
            "Authorization": "Bearer " + tokens["access_token"],
            "X-Client-ID": json.loads((ROOT / "deploy/client_ids.json").read_text())[0],
        }

        async def check():
            with wave.open(
                str(ROOT / "models/paraformer/example/asr_example.wav")
            ) as f:
                assert (f.getframerate(), f.getnchannels(), f.getsampwidth()) == (
                    16000,
                    1,
                    2,
                )
                pcm = f.readframes(f.getnframes())
            async with websockets.connect(
                "wss://api.hilex.me/ws/asr",
                extra_headers=headers,
                open_timeout=30,
            ) as ws:
                ready = json.loads(await asyncio.wait_for(ws.recv(), 30))
                assert ready["type"] == "ready"
                for start in range(0, len(pcm), 19200):
                    await ws.send(pcm[start : start + 19200])
                await ws.send(json.dumps({"type": "end"}))
                parts = []
                final = None
                async for message in ws:
                    event = json.loads(message)
                    assert event["type"] != "error", event
                    if event["type"] in ["partial", "final"]:
                        parts.append(event["delta"])
                    if event["type"] == "final":
                        final = event
                        break
                assert final and final["text"] and final["text"] == "".join(parts)
                result["asr"] = {
                    "ready": True,
                    "final_received": True,
                    "delta_cumulative_parity": True,
                    "audio_bytes": len(pcm),
                }
            async with websockets.connect(
                "wss://api.hilex.me/ws/tts",
                extra_headers=headers,
                open_timeout=30,
            ) as ws:
                ready = json.loads(await asyncio.wait_for(ws.recv(), 30))
                assert ready["type"] == "ready"
                await ws.send(
                    json.dumps({"type": "text", "text": "你好。"}, ensure_ascii=False)
                )
                await ws.send(json.dumps({"type": "end"}))
                total = 0
                done = False
                async for message in ws:
                    if isinstance(message, bytes):
                        assert len(message) % 2 == 0
                        total += len(message)
                    else:
                        event = json.loads(message)
                        assert event["type"] != "error", event
                        if event["type"] == "done":
                            done = True
                            break
                assert done and total > 0
                result["tts"] = {
                    "ready": True,
                    "sample_rate": ready["sample_rate"],
                    "audio_bytes": total,
                    "done_received": True,
                }

        asyncio.run(asyncio.wait_for(check(), 120))
        r = c.post(
            "https://accounts.hilex.me/auth/logout",
            json={"refresh_token": tokens["refresh_token"]},
        )
        r.raise_for_status()
    (ROOT / "artifacts/single-domain-ws-live.json").write_text(
        json.dumps(result, indent=2) + "\n"
    )
    print(json.dumps(result, indent=2))
finally:
    store.update_user(primary["id"], user["id"], {"enabled": False})
    store.db.close()
