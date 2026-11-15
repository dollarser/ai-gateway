"""Streaming encoders produce decodable audio before the upload finishes."""

import asyncio
import unittest
from gateway.codec_stream import stream_encode
from gateway.audio import transcode


class CodecStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_stream_formats_emit_before_upload_eof(self):
        for fmt in ("mp3", "opus", "flac"):
            with self.subTest(format=fmt):
                release = asyncio.Event()

                class Upload:
                    async def stream(self):
                        yield b"\0\0" * 24000 * 4
                        await release.wait()
                        yield b"\0\0" * 24000

                response = await stream_encode(Upload(), fmt)
                iterator = response.body_iterator
                try:
                    first = await asyncio.wait_for(anext(iterator), 10)
                    self.assertTrue(first)
                    self.assertFalse(release.is_set())
                    release.set()
                    data = first + b"".join([part async for part in iterator])
                    decoded = await transcode(data)
                    self.assertGreater(len(decoded), 150000)
                finally:
                    release.set()
                    await iterator.aclose()

    async def test_bad_format_rejected_before_starting_encoder(self):
        with self.assertRaisesRegex(Exception, "格式"):
            await stream_encode(None, "wav")
