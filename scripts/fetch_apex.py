"""Downloads the result PDFs of the Apex Timing "GoRacing" events listed in
data/apex/sources.json into data/apex/<event>/, and writes
data/apex/manifest.json listing them. The app reads that manifest and imports
new/changed PDFs by itself - it can't fetch them from apex-timing.com directly,
since that site doesn't allow cross-origin requests.

Run by .github/workflows/fetch-results.yml on a schedule; can also be run by
hand: python3 scripts/fetch_apex.py
"""

import hashlib
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://www.apex-timing.com/goracing/"
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "apex"

# Only sessions that feed the standings: the (combined) qualifying, the
# group-vs-group heats and the super heats. Skipped: practice, warm up, the
# per-group qualifying sheets, and the "Provisional Qualifying" / "Qualifying
# Heats" / "Super Heats" rankings, which the app computes itself.
WANTED = re.compile(r"^(Qualifying Practice|Qualifying Heat \S+(?: \S+)?|Super Heat(?: \S+)?)$", re.I)
SKIPPED = re.compile(r"\bGroup\b|^Qualifying Heats$|^Super Heats$", re.I)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (DFK Karting Klassement)"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.headers.get("Content-Type", ""), resp.read()


def list_sessions(path):
    """All result entries on an event's results page, across every class."""
    _, raw = fetch(f"{BASE}results.php?path={urllib.parse.quote(path)}&group=1")
    page = raw.decode("utf-8", "replace")
    sessions = []
    groups = re.split(r'(?=<div class="group_submenu)', page)
    for block in groups:
        g = re.match(r'<div class="group_submenu[^"]*" data-group="([^"]+)" data-group_title="([^"]*)"', block)
        if not g:
            continue
        for m in re.finditer(r'data-id="([^"]+)">\s*<span data-image="([^"]*)" class="title">([^<]*)</span>', block):
            sessions.append({"className": g.group(2).strip(), "id": m.group(1), "type": m.group(2), "title": m.group(3).strip()})
    return sessions


def main():
    sources = json.loads((DATA / "sources.json").read_text())
    manifest_path = DATA / "manifest.json"
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"files": []}
    known = {f["path"]: f for f in previous.get("files", [])}

    files = []
    for source in sources:
        path = source["path"]
        slug = path.strip("/").replace("/", "-")
        try:
            sessions = list_sessions(path)
        except Exception as e:  # keep what we had for this event if the page is down
            print(f"{path}: kon resultatenpagina niet ophalen: {e}", file=sys.stderr)
            files.extend(f for f in known.values() if f["path"].startswith(f"data/apex/{slug}/"))
            continue

        for s in sessions:
            # "list" is a start list (not raced yet), "" not published at all.
            if not s["type"].startswith("result") or not WANTED.match(s["title"]) or SKIPPED.search(s["title"]):
                continue
            rel = f"data/apex/{slug}/{s['id']}.pdf"
            pdf_url = f"{BASE}results_download.php?pdf=" + urllib.parse.quote(f"results{path}{s['id']}.pdf", safe="")
            try:
                ctype, body = fetch(pdf_url)
            except Exception as e:
                print(f"{rel}: download mislukt: {e}", file=sys.stderr)
                if rel in known:
                    files.append(known[rel])
                continue
            if "pdf" not in ctype or not body.startswith(b"%PDF"):
                continue
            target = ROOT / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists() or target.read_bytes() != body:
                target.write_bytes(body)
                print(f"bijgewerkt: {rel} ({s['className']} - {s['title']})")
            files.append({
                "path": rel,
                "event": source.get("name", path),
                "className": s["className"],
                "title": s["title"],
                "sha1": hashlib.sha1(body).hexdigest(),
            })

    manifest = {"files": files}
    if manifest != {"files": previous.get("files", [])}:
        manifest_path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
