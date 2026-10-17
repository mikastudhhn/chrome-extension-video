"""Generate local test footage with a known five-second version difference."""
import argparse
from pathlib import Path
import shutil
import subprocess


def generate(output, font_path=None):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as error:
        raise RuntimeError("Install demo dependencies: python3 -m pip install -r scripts/requirements-demo.txt") from error
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg with the libvpx-vp9 encoder is required on PATH.")
    # Pillow bundles this font; the default no longer depends on an OS font directory.
    font = ImageFont.truetype(str(font_path), 55) if font_path else ImageFont.load_default(size=55)
    output.mkdir(parents=True, exist_ok=True)
    common = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    encoding = ["-c:v", "libvpx-vp9", "-threads", "1", "-b:v", "0", "-crf", "38", "-an"]
    process = subprocess.Popen(common + [
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "640x300", "-r", "12", "-i", "-",
    ] + encoding + [str(output / "scene-a.webm")], stdin=subprocess.PIPE)
    try:
        for frame in range(45 * 12):
            image = Image.new("RGB", (640, 300), "#234335")
            draw = ImageDraw.Draw(image)
            draw.text((320, 135), f"SCENE {frame // 12:02d}", font=font, fill="#f3f5ee", anchor="mm")
            draw.rectangle((32, 258, 32 + int(576 * (frame % 12) / 11), 263), fill="#c4d5a9")
            process.stdin.write(image.tobytes())
    finally:
        try:
            process.stdin.close()
        finally:
            status = process.wait()
    if status != 0:
        raise RuntimeError("Video encoding failed")
    subprocess.run(common + [
        "-i", str(output / "scene-a.webm"), "-vf", "tpad=start_duration=5:start_mode=add:color=0x12241b",
    ] + encoding + [str(output / "scene-b.webm")], check=True)
    print(f"Generated scene-a.webm (45 s) and scene-b.webm (50 s) in {output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent.parent / "demo")
    parser.add_argument("--font", type=Path, help="Optional explicit TrueType/OpenType font; default is bundled with Pillow")
    args = parser.parse_args()
    try:
        generate(args.output_dir, args.font)
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Demo generation failed: {error}\n")


if __name__ == "__main__":
    main()
