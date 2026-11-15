"""Decode-based audio accounting and cloud speech routing contracts."""

import asyncio
import io
import json
import unittest
import wave
from dataclasses import replace
import httpx
import test_accounts as baseline
from accounts.store import Denied
from gateway.audio import transcode
from gateway.auth import inference_metadata


def wav_bytes(seconds=1, rate=16000):
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\0\0" * int(seconds * rate))
    return out.getvalue()


class AudioDecodeTests(unittest.TestCase):
    def test_upload_is_decoded_and_duration_comes_from_actual_pcm(self):
        pcm = asyncio.run(transcode(wav_bytes()))
        self.assertEqual(len(pcm), 32000)
        encoded = asyncio.run(
            transcode(b"\0\0" * 24000, encode=True, output_format="mp3")
        )
        self.assertTrue(encoded)
        decoded = asyncio.run(transcode(encoded))
        self.assertGreaterEqual(len(decoded), 32000)
        self.assertLess(len(decoded), 40000)

    def test_invalid_audio_and_overlong_audio_fail_without_upstream(self):
        with self.assertRaises(Denied):
            asyncio.run(transcode(b"not audio"))
        with self.assertRaises(Denied) as context:
            asyncio.run(transcode(wav_bytes(301)))
        self.assertEqual(context.exception.status, 413)

    def test_wav_output_has_exact_header_sizes(self):
        wav = asyncio.run(transcode(b"\0\0" * 24000, encode=True, output_format="wav"))
        with wave.open(io.BytesIO(wav)) as w:
            self.assertEqual(w.getnframes(), 24000)
            self.assertEqual(w.getframerate(), 24000)

    def test_ip_is_taken_from_trusted_tunnel_and_client_metadata_is_bounded(self):
        scope = {"client": ("127.0.0.1", 1), "server": ("127.0.0.1", 18900)}
        headers = {
            "cf-connecting-ip": "203.0.113.12",
            "x-forwarded-for": "203.0.113.99",
            "user-agent": "x" * 700,
            "x-client-version": "1.2.3",
            "x-device-id": "opaque",
        }
        meta = inference_metadata(scope, headers)
        self.assertEqual(meta["client_ip"], "203.0.113.12")
        self.assertEqual(len(meta["user_agent"]), 512)
        self.assertIsNone(
            inference_metadata(scope, {"x-forwarded-for": "203.0.113.99"})["client_ip"]
        )
        self.assertEqual(
            inference_metadata(
                {"client": ("198.51.100.1", 1), "server": ("127.0.0.1", 18900)}, headers
            )["client_ip"],
            "198.51.100.1",
        )


class AudioGatewayTests(unittest.TestCase):
    setUp = baseline.HTTPTests.setUp
    tearDown = baseline.HTTPTests.tearDown
    login = baseline.HTTPTests.login
    key = baseline.HTTPTests.key
    post = baseline.HTTPTests.post

    def configure(self, backend):
        self.app.state.settings = replace(
            self.app.state.settings,
            accounts_worker_url="https://accounts.hilex.me",
            accounts_worker_secret="internal-secret-" * 4,
        )
        self.client.portal.call(self.mock.aclose)
        self.mock = httpx.AsyncClient(transport=httpx.MockTransport(backend))
        self.app.state.client = self.mock

    def test_asr_normalizes_and_sends_only_internal_credentials(self):
        seen = []

        async def backend(request):
            seen.append(request.url.path)
            self.assertEqual(
                request.headers["authorization"],
                "Bearer " + self.app.state.settings.accounts_worker_secret,
            )
            self.assertTrue(request.headers["x-gateway-lease"])
            self.assertIn(b"RIFF", request.content)
            self.assertIn(b"audio.wav", request.content)
            self.assertNotIn(b"milliseconds", request.content)
            return httpx.Response(200, json={"text": "hello"})

        self.configure(backend)
        headers = {"Authorization": "Bearer " + self.key(["asr"])["key"]}
        r = self.client.post(
            "https://api.hilex.me/v1/audio/transcriptions",
            data={"model": "gpt-transcribe"},
            files={"file": ("recording.any", wav_bytes(), "audio/wav")},
            headers=headers,
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["text"], "hello")
        self.assertEqual(seen, ["/internal/openai/transcriptions"])

    def test_tts_keeps_http_interface_and_encodes_audio(self):
        async def backend(request):
            self.assertEqual(request.url.path, "/internal/openai/speech")
            self.assertEqual(json.loads(request.content)["response_format"], "pcm")
            return httpx.Response(
                200, content=b"\0\0" * 24000, headers={"content-type": "audio/pcm"}
            )

        self.configure(backend)
        headers = {"Authorization": "Bearer " + self.key(["tts"])["key"]}
        r = self.client.post(
            "https://api.hilex.me/v1/audio/speech",
            json={
                "model": "gpt-realtime-2.1-mini",
                "input": "你好🙂",
                "response_format": "wav",
            },
            headers=headers,
        )
        self.assertEqual(
            r.status_code, 200, r.text[:100] if r.status_code != 200 else ""
        )
        with wave.open(io.BytesIO(r.content)) as w:
            self.assertEqual(w.getnframes(), 24000)
        self.assertEqual(r.headers["content-type"], "audio/wav")

    def test_cloud_audio_rejects_unauthenticated_local_listener(self):
        async def run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.app, client=("127.0.0.1", 1234))
            ) as c:
                return await c.post(
                    "http://127.0.0.1:18901/v1/audio/speech",
                    json={"model": "gpt-realtime-2.1-mini", "input": "hello"},
                )

        self.assertEqual(asyncio.run(run()).status_code, 403)
