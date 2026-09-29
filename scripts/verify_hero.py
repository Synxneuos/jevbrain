import os
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright

OUTPUT_DIR = r"C:\Users\Naquib\.gemini\antigravity\brain\39ad0cb5-9dcb-4c40-9a0f-bd37e960cc99"

import threading
import socketserver
from http.server import SimpleHTTPRequestHandler

PORT = 8093
PUBLIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public"))

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)
    def log_message(self, format, *args):
        pass

def run_server():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        httpd.serve_forever()

server_thread = threading.Thread(target=run_server, daemon=True)
server_thread.start()
time.sleep(1)

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        args=["--enable-webgl", "--ignore-gpu-blocklist", "--use-gl=angle"]
    )
    page = browser.new_page(viewport={"width": 1920, "height": 1080})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: print(f"[CONSOLE {m.type}] {m.text}"))

    print("Navigating to homepage...")
    page.goto(f"http://127.0.0.1:{PORT}/index.html", wait_until="networkidle")

    time.sleep(2)
    has_canvas = page.evaluate("!!document.querySelector('#hero-3d-bg canvas')")
    has_pill = page.evaluate("!!document.querySelector('.hero-3d-pill')")
    has_nav = page.evaluate("!!document.querySelector('a[href=\"/cinematic\"]')")

    print(f"Hero 3D Canvas Present: {has_canvas}")
    print(f"Hero 3D Pill Link Present: {has_pill}")
    print(f"Sidebar Nav 3D Link Present: {has_nav}")

    out_file = os.path.join(OUTPUT_DIR, "homepage_hero_3d.png")
    page.screenshot(path=out_file)
    print(f"Saved: {out_file}")

    if errors:
        print("Page Errors:", errors)
        sys.exit(1)
    else:
        print("Zero errors on homepage!")

    browser.close()
