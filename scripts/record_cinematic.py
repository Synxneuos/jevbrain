import os
import sys
import time
import subprocess
import threading
import socketserver
from http.server import SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')

PORT = 8095
PUBLIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public"))
OUTPUT_DIR = r"C:\Users\Naquib\.gemini\antigravity\brain\39ad0cb5-9dcb-4c40-9a0f-bd37e960cc99"
TEMP_VIDEO_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "temp_rec"))

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)
    def log_message(self, format, *args):
        pass

def run_server():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        httpd.serve_forever()

def main():
    os.makedirs(TEMP_VIDEO_DIR, exist_ok=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()
    time.sleep(1)

    print(f"Server started at http://127.0.0.1:{PORT}", flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--enable-webgl",
                "--ignore-gpu-blocklist",
                "--use-gl=angle",
                "--enable-gpu-rasterization"
            ]
        )
        context = browser.new_context(
            record_video_dir=TEMP_VIDEO_DIR,
            record_video_size={"width": 1920, "height": 1080},
            viewport={"width": 1920, "height": 1080}
        )
        page = context.new_page()

        print("Opening cinematic experience (36-second sequence)...", flush=True)
        page.goto(f"http://127.0.0.1:{PORT}/cinematic.html?autoplay=true&recording=true", wait_until="domcontentloaded")

        # Wait for Three.js engine
        page.wait_for_function("typeof window.seekCinematicTime === 'function'")
        print("Sequence started playing. Recording in real-time without player controls...", flush=True)

        # Allow full 36s cinematic sequence to play through smoothly
        duration = 36.5
        start_t = time.time()
        while time.time() - start_t < duration:
            elapsed = time.time() - start_t
            pct = min(100.0, (elapsed / duration) * 100)
            sys.stdout.write(f"\rRecording progress: {elapsed:.1f}s / {duration:.1f}s ({pct:.0f}%)")
            sys.stdout.flush()
            time.sleep(0.5)

        print("\nSequence finished! Finalizing video stream...", flush=True)
        page.close()
        video_path = page.video.path()
        context.close()
        browser.close()

    print(f"Captured WebM recording: {video_path}", flush=True)

    # Convert to High Quality MP4 with FFmpeg
    output_mp4 = os.path.join(OUTPUT_DIR, "jevbrain_cinematic_1080p.mp4")
    public_mp4 = os.path.join(PUBLIC_DIR, "assets", "jevbrain_cinematic_1080p.mp4")

    # Generate synthetic 55Hz cinematic sub-bass drone with harmonic overtone
    # so MP4 has matching computational audio track
    ffmpeg_cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-f", "lavfi", "-i", "anoisesrc=d=36.5:c=pink:a=0.03,lowpass=f=200",
        "-f", "lavfi", "-i", "sine=f=55:d=36.5",
        "-filter_complex", "[1:a][2:a]amix=inputs=2:weights=0.3 0.7,volume=1.2[aout]",
        "-map", "0:v",
        "-map", "[aout]",
        "-c:v", "libx264",
        "-preset", "slow",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        output_mp4
    ]

    print("Transcoding to 1080p MP4 with FFmpeg...", flush=True)
    res = subprocess.run(ffmpeg_cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print("FFmpeg error:", res.stderr)
        # Fallback without audio filter if lavfi has any issue
        fallback_cmd = [
            "ffmpeg", "-y",
            "-i", video_path,
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "19",
            "-pix_fmt", "yuv420p",
            output_mp4
        ]
        subprocess.run(fallback_cmd, check=True)

    # Also copy to public/assets for website download / embedding
    import shutil
    shutil.copyfile(output_mp4, public_mp4)

    mp4_size_mb = os.path.getsize(output_mp4) / (1024 * 1024)
    print(f"SUCCESS! Output MP4 saved to: {output_mp4} ({mp4_size_mb:.2f} MB)", flush=True)
    print(f"Also published to: {public_mp4}", flush=True)

if __name__ == "__main__":
    main()
