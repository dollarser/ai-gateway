"""Cloud demo handles PCM sample boundaries and writes only whole samples."""

import tempfile
import unittest
import wave
from pathlib import Path
from scripts.clients.client import write_pcm


class CloudAudioClientTests(unittest.TestCase):
    def test_chunk_boundaries_may_split_samples(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "test.wav"
            write_pcm([b"\0", b"\0\0", b"\0"], output)
            with wave.open(str(output)) as wav:
                self.assertEqual(wav.getframerate(), 24000)
                self.assertEqual(wav.getnframes(), 2)
                self.assertEqual(wav.readframes(2), b"\0" * 4)

    def test_odd_final_sample_is_an_error(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, "Incomplete"):
                write_pcm([b"\0"], Path(folder) / "bad.wav")
