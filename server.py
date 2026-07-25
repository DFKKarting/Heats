"""
Local server for Karting Klassement: serves the static site AND runs a
background watcher that polls the Sportity results channel, downloads new
heat/qualifying PDFs, and makes them available to the web app via /api/incoming.

No third-party dependencies - stdlib only, so no `pip install` is needed to run.
"""

import http.server
import json
import os
import re
import socketserver
import sys
import threading
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

INCOMING_DIR = os.path.join(ROOT, "_incoming")
SEEN_FILE = os.path.join(ROOT, "_seen_urls.json")
CHANNEL_URL = "https://webapp.sportity.com/channel/isb2026"
POLL_INTERVAL_SECONDS = 60
REQUEST_HEADERS = {"User-Agent": "Mozilla/5.0"}
MAX_DOWNLOAD_ATTEMPTS = 3

failed_attempts = {}

os.makedirs(INCOMING_DIR, exist_ok=True)


def load_seen():
    if os.path.exists(SEEN_FILE):
        try:
            with open(SEEN_FILE, "r", encoding="utf-8") as f:
                return set(json.load(f))
        except Exception:
            return set()
    return set()


def save_seen(seen):
    with open(SEEN_FILE, "w", encoding="utf-8") as f:
        json.dump(sorted(seen), f)


def sanitize_filename(name):
    return re.sub(r'[<>:"/\\|?*]', "_", name).strip()


def encode_url_for_fetch(url):
    # Sportity's raw HTML has unescaped spaces (and possibly other unsafe chars)
    # straight in the href, which urllib refuses to open as-is.
    parsed = urllib.parse.urlsplit(url)
    safe_path = urllib.parse.quote(parsed.path, safe="/:@")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, safe_path, parsed.query, parsed.fragment))


def is_relevant_pdf(display_name):
    lower = display_name.lower()
    if re.search(r"lap\s*(times|time|chart)", lower) or "startgrid" in lower:
        return False
    if re.search(r"heat\s*\d+", lower):
        return True
    if "total qualifying practice" in lower:
        return True
    return False


def poll_sportity():
    seen = load_seen()
    while True:
        try:
            req = urllib.request.Request(CHANNEL_URL, headers=REQUEST_HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                html = resp.read().decode("utf-8", errors="ignore")
            urls = set(re.findall(r'href="(https://app-cdn\.sportity\.com/[^"]+\.pdf)"', html))
            for url in urls:
                if url in seen:
                    continue
                decoded = urllib.parse.unquote(url)
                raw_name = decoded.rsplit("/", 1)[-1]
                display_name = re.sub(r"^[0-9a-f-]{20,}_", "", raw_name, flags=re.I)
                if not is_relevant_pdf(display_name):
                    seen.add(url)
                    continue
                try:
                    pdf_req = urllib.request.Request(encode_url_for_fetch(url), headers=REQUEST_HEADERS)
                    with urllib.request.urlopen(pdf_req, timeout=30) as pdf_resp:
                        data = pdf_resp.read()
                    safe_name = sanitize_filename(display_name)
                    target = os.path.join(INCOMING_DIR, safe_name)
                    if os.path.exists(target):
                        base, ext = os.path.splitext(safe_name)
                        target = os.path.join(INCOMING_DIR, f"{base}_{int(time.time())}{ext}")
                    # Write to a temp file first and atomically rename - avoids the
                    # web app reading a half-written PDF if it polls mid-download.
                    tmp_target = target + ".tmp"
                    with open(tmp_target, "wb") as f:
                        f.write(data)
                    os.replace(tmp_target, target)
                    print(f"[watcher] downloaded: {safe_name}")
                    seen.add(url)
                    save_seen(seen)
                except Exception as e:
                    failed_attempts[url] = failed_attempts.get(url, 0) + 1
                    if failed_attempts[url] >= MAX_DOWNLOAD_ATTEMPTS:
                        print(f"[watcher] giving up on {url} after {MAX_DOWNLOAD_ATTEMPTS} attempts: {e}")
                        seen.add(url)
                        save_seen(seen)
                        failed_attempts.pop(url, None)
                    else:
                        print(f"[watcher] failed to download {url} (attempt {failed_attempts[url]}/{MAX_DOWNLOAD_ATTEMPTS}): {e}")
        except Exception as e:
            print(f"[watcher] failed to fetch channel page: {e}")
        time.sleep(POLL_INTERVAL_SECONDS)


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/incoming":
            files = sorted(f for f in os.listdir(INCOMING_DIR) if not f.endswith(".tmp")) if os.path.isdir(INCOMING_DIR) else []
            body = json.dumps(files).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/incoming/processed":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length else b"{}"
            try:
                payload = json.loads(body)
                names = payload.get("files", [])
            except Exception:
                names = []
            for name in names:
                safe = os.path.basename(name)
                path = os.path.join(INCOMING_DIR, safe)
                if os.path.exists(path):
                    os.remove(path)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, fmt, *args):
        print(f"[server] {self.address_string()} - {fmt % args}")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    watcher = threading.Thread(target=poll_sportity, daemon=True)
    watcher.start()
    with socketserver.ThreadingTCPServer(("", port), Handler) as httpd:
        print(f"Serving {ROOT} on port {port}")
        print(f"Watching {CHANNEL_URL} every {POLL_INTERVAL_SECONDS}s for new heat/qualifying PDFs")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
