"""Opt-in integration test: python3 tests/generate-demo.test.py (Pillow, ffmpeg, ffprobe)."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class DemoGeneration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="video-sync-demo-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.output = Path(cls.temporary.name)
        subprocess.run([sys.executable, str(ROOT / "scripts/generate-demo.py"),
                        "--output-dir", str(cls.output)], check=True, capture_output=True)

    def test_durations_dimensions_and_frame_rate(self):
        for name, duration in [("scene-a.webm", 45), ("scene-b.webm", 50)]:
            result = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json",
                                     str(self.output / name)], check=True, capture_output=True, text=True)
            metadata = json.loads(result.stdout)
            self.assertEqual(len(metadata["streams"]), 1)
            stream = metadata["streams"][0]
            self.assertEqual((stream["codec_name"], stream["width"], stream["height"], stream["r_frame_rate"]),
                             ("vp9", 640, 300, "12/1"))
            self.assertAlmostEqual(float(metadata["format"]["duration"]), duration, delta=1 / 12)

    def frame(self, name, second):
        return subprocess.run(["ffmpeg", "-v", "error", "-ss", str(second), "-i", str(self.output / name),
                               "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                              check=True, capture_output=True).stdout

    def test_same_scene_after_exactly_five_seconds(self):
        for second in [0, 5, 20, 44]:
            original = self.frame("scene-a.webm", second)
            shifted = self.frame("scene-b.webm", second + 5)
            self.assertEqual(len(original), 640 * 300 * 3)
            self.assertEqual(len(shifted), len(original))
            # VP9 is lossy: compare decoded images, not encoded bytes.
            self.assertLess(sum(abs(a - b) for a, b in zip(original, shifted)) / len(original), 4)
        lead_in = self.frame("scene-b.webm", 4)
        self.assertLess(max(lead_in) - min(lead_in), 30)
        self.assertLess(max(lead_in), 50)

    def test_invalid_explicit_font_fails_with_actionable_message(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/generate-demo.py"),
                                 "--font", str(self.output / "missing.ttf"), "--output-dir", str(self.output / "invalid")],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Demo generation failed", result.stderr)
        self.assertFalse((self.output / "invalid").exists())


if __name__ == "__main__":
    unittest.main()
