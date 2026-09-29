import os
import sys
import time
import socket
import threading
from http.server import SimpleHTTPRequestHandler
import socketserver
from playwright.sync_api import sync_playwright

PORT = 8092
PUBLIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public"))
OUTPUT_DIR = r"C:\Users\Naquib\.gemini\antigravity\brain\39ad0cb5-9dcb-4c40-9a0f-bd37e960cc99"

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
    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()
    time.sleep(1)

    print(f"Server started serving {PUBLIC_DIR} at http://127.0.0.1:{PORT}")

    console_logs = []
    page_errors = []

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
        page = browser.new_page(viewport={"width": 1920, "height": 1080})

        page.on("console", lambda msg: print(f"[BROWSER {msg.type.upper()}] {msg.text}", flush=True))
        page.on("pageerror", lambda err: print(f"[BROWSER ERROR] {err}", flush=True))
        page.on("requestfailed", lambda req: print(f"[FAILED REQ] {req.url} - {req.failure}", flush=True))
        page.on("response", lambda res: print(f"[HTTP {res.status}] {res.url}", flush=True) if res.status >= 400 else None)

        print("Navigating to cinematic page...", flush=True)
        page.goto(f"http://127.0.0.1:{PORT}/cinematic.html?autoplay=true&recording=true", wait_until="domcontentloaded")

        # Wait for Three.js engine and window.seekCinematicTime
        try:
            page.wait_for_function("typeof window.seekCinematicTime === 'function'", timeout=8000)
            print("Three.js cinematic engine successfully loaded and initialized!", flush=True)
        except Exception as e:
            print(f"Wait failed: {e}", flush=True)
            print("Page title:", page.title(), flush=True)
            print("Page content length:", len(page.content()), flush=True)
            raise

        scenes = [
            ("scene_01_seed", 2.5),
            ("scene_02_graph", 8.5),
            ("scene_03_activation", 14.5),
            ("scene_04_agents", 21.0),
            ("scene_05_execution", 28.0),
            ("scene_06_macro", 33.5)
        ]

        os.makedirs(OUTPUT_DIR, exist_ok=True)

        for name, t in scenes:
            print(f"Seeking to t={t}s ({name})...", flush=True)
            page.evaluate(f"window.seekCinematicTime({t})")
            time.sleep(0.4) # Allow WebGL frame update & CSS transitions
            img_path = os.path.join(OUTPUT_DIR, f"{name}.png")
            page.screenshot(path=img_path)
            print(f"Saved: {img_path}", flush=True)

        # Test Interactive Mode
        print("Testing Interactive Mode & System Drawer...", flush=True)
        page.evaluate("document.getElementById('btn-interactive').click()")
        time.sleep(0.3)
        page.evaluate("window.showClusterDrawer('model')")
        time.sleep(0.4)
        drawer_path = os.path.join(OUTPUT_DIR, "scene_07_interactive.png")
        page.screenshot(path=drawer_path)
        print(f"Saved: {drawer_path}", flush=True)

        print("\n--- Console Logs Summary ---")
        for log in console_logs[-10:]:
            print(log)

        if page_errors:
            print("\n--- Page Errors Found ---")
            for err in page_errors:
                print(err)
            sys.exit(1)
        else:
            print("\nZero JavaScript or WebGL runtime errors detected!")

        browser.close()

if __name__ == "__main__":
    main()
