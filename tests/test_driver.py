#!/usr/bin/env python3
"""Unit tests for driver/mimo_driver.py build_body — no network, asserts the
exact chat body shape the driver assembles for each kind.

Run: python3 tests/test_driver.py  (or `python3 -m unittest tests.test_driver`)
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "driver"))

import mimo_driver  # noqa: E402


class BuildBodyTest(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.dir = self._tmpdir.name

    def tearDown(self):
        self._tmpdir.cleanup()

    def touch(self, name="media.bin"):
        p = os.path.join(self.dir, name)
        with open(p, "wb") as fh:
            fh.write(b"\x00\x01\x02fake-media-bytes")
        return p

    def spec(self, **overrides):
        base = {"model": "mimo-v2.6-flash", "key": "k", "url": "https://api.xiaomimimo.com/v1/chat/completions"}
        base.update(overrides)
        return base

    def test_asr_local_audio(self):
        body = mimo_driver.build_body(self.spec(kind="asr", files=[{"kind": "audio", "mime": "audio/wav", "path": self.touch("a.wav")}]))
        self.assertEqual(body["stream"], False)
        self.assertNotIn("thinking", body)
        self.assertNotIn("asr_options", body)
        c = body["messages"][0]["content"]
        self.assertEqual(c[0]["type"], "input_audio")
        self.assertTrue(c[0]["input_audio"]["data"].startswith("data:audio/wav;base64,"))

    def test_asr_with_language(self):
        body = mimo_driver.build_body(self.spec(kind="asr", language="zh"))
        self.assertEqual(body["asr_options"], {"language": "zh"})

    def test_audio_url_goes_to_input_audio(self):
        """Regression: URL input must reach input_audio.data (was silently dropped)."""
        body = mimo_driver.build_body(self.spec(kind="audio", urls=["https://example.com/a.mp3"], prompt="what?"))
        c = body["messages"][0]["content"]
        self.assertEqual(c[0]["type"], "input_audio")
        self.assertEqual(c[0]["input_audio"]["data"], "https://example.com/a.mp3")
        self.assertEqual(c[1]["type"], "text")

    def test_asr_url_is_downloaded_to_data_url(self):
        """ASR rejects bare URLs (input_audio.data must be base64/data URL) —
        the driver must download the URL and re-encode it."""
        import unittest.mock as mock
        with mock.patch.object(mimo_driver, "_fetch_b64", return_value="QUJD") as fb:
            body = mimo_driver.build_body(self.spec(kind="asr", urls=["https://example.com/a.mp3"]))
        fb.assert_called_once_with("https://example.com/a.mp3", 90)
        c = body["messages"][0]["content"]
        self.assertEqual(c[0]["type"], "input_audio")
        self.assertEqual(c[0]["input_audio"]["data"], "data:audio/mpeg;base64,QUJD")

    def test_asr_url_mime_fallback_wav(self):
        import unittest.mock as mock
        with mock.patch.object(mimo_driver, "_fetch_b64", return_value="QUJD"):
            body = mimo_driver.build_body(self.spec(kind="asr", urls=["https://example.com/clip"]))
        c = body["messages"][0]["content"]
        self.assertEqual(c[0]["input_audio"]["data"], "data:audio/wav;base64,QUJD")

    def test_asr_data_url_passes_through(self):
        """A data: URL is already a valid ASR input — it must NOT be downloaded
        (urlopen would raise ValueError: unknown url type: 'data')."""
        body = mimo_driver.build_body(self.spec(kind="asr", urls=["data:audio/wav;base64,QUJD"]))
        c = body["messages"][0]["content"]
        self.assertEqual(c[0]["input_audio"]["data"], "data:audio/wav;base64,QUJD")

    def test_mime_of_url_data_url(self):
        self.assertEqual(mimo_driver._mime_of_url("data:audio/mpeg;base64,QUJD"), "audio/mpeg")
        self.assertEqual(mimo_driver._mime_of_url("https://e.com/a.mp3?token=1#frag"), "audio/mpeg")
        self.assertEqual(mimo_driver._mime_of_url("https://e.com/clip"), "audio/wav")

    def test_audio_local_file_is_data_url(self):
        body = mimo_driver.build_body(self.spec(kind="audio", files=[{"kind": "audio", "mime": "audio/mpeg", "path": self.touch("a.mp3")}]))
        c = body["messages"][0]["content"]
        self.assertTrue(c[0]["input_audio"]["data"].startswith("data:audio/mpeg;base64,"))

    def test_vision_urls_and_files(self):
        body = mimo_driver.build_body(self.spec(kind="vision", files=[{"kind": "image", "mime": "image/png", "path": self.touch("i.png")}], urls=["https://e.com/i.jpg"], prompt="look"))
        c = body["messages"][0]["content"]
        self.assertEqual(c[0]["type"], "image_url")
        self.assertTrue(c[0]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.assertEqual(c[1]["type"], "image_url")
        self.assertEqual(c[1]["image_url"]["url"], "https://e.com/i.jpg")

    def test_video_url_with_fps_and_resolution(self):
        body = mimo_driver.build_body(self.spec(kind="video", urls=["https://e.com/v.mp4"], fps=2, media_resolution="max", prompt="desc"))
        c = body["messages"][0]["content"]
        self.assertEqual(c[0]["type"], "video_url")
        self.assertEqual(c[0]["video_url"]["url"], "https://e.com/v.mp4")
        self.assertEqual(c[0]["fps"], 2.0)
        self.assertEqual(c[0]["media_resolution"], "max")
        self.assertEqual(c[1]["type"], "text")

    def test_video_fractional_fps(self):
        """The API fps is a float in [0.1, 10.0] — a fractional value must survive."""
        body = mimo_driver.build_body(self.spec(kind="video", urls=["https://e.com/v.mp4"], fps=0.5, prompt="desc"))
        c = body["messages"][0]["content"]
        self.assertEqual(c[0]["fps"], 0.5)

    def test_video_local_file_is_data_url(self):
        body = mimo_driver.build_body(self.spec(kind="video", files=[{"kind": "video", "mime": "video/mp4", "path": self.touch("v.mp4")}]))
        c = body["messages"][0]["content"]
        self.assertEqual(c[0]["type"], "video_url")
        self.assertTrue(c[0]["video_url"]["url"].startswith("data:video/mp4;base64,"))
        self.assertNotIn("fps", c[0])

    def test_think_enables_thinking(self):
        body = mimo_driver.build_body(self.spec(kind="think", prompt="hard problem"))
        self.assertEqual(body["thinking"], {"type": "enabled"})
        # max_completion_tokens covers reasoning tokens too (API range [1, 131072]).
        self.assertEqual(body["max_completion_tokens"], 16384)
        self.assertNotIn("response_format", body)

    def test_json_uses_response_format(self):
        body = mimo_driver.build_body(self.spec(kind="json", prompt="give me json"))
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertEqual(body["max_completion_tokens"], 8192)
        self.assertEqual(body["messages"][0]["role"], "system")
        self.assertIn("JSON", body["messages"][0]["content"])
        self.assertEqual(body["messages"][1]["role"], "user")

    def test_default_chat_has_thinking_disabled(self):
        """MiMo-V2.6 enables thinking by default — plain calls must disable it."""
        body = mimo_driver.build_body(self.spec(kind="chat", prompt="hi"))
        self.assertEqual(body["thinking"], {"type": "disabled"})
        self.assertEqual(body["model"], "mimo-v2.6-flash")
        self.assertNotIn("response_format", body)


if __name__ == "__main__":
    unittest.main(verbosity=2)
