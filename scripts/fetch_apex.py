"""Downloads the result PDFs of the events listed in data/apex/sources.json
into data/apex/<event>/, and writes data/apex/manifest.json listing them. The
app reads that manifest and imports new/changed PDFs by itself - it can't
fetch them from the result sites directly, since those don't allow
cross-origin requests.

Supported sources ("type" in sources.json):
- "apex" (default): an Apex Timing "GoRacing" results page, by its "path"
  (e.g. IAME Finals).
- "sportity": a Sportity web app event page, by its "url" (e.g. IAME Series
  Benelux) - its "<Class> Results + Groups" sections link the timing PDFs.

Run by .github/workflows/fetch-results.yml on a schedule; can also be run by
hand: python3 scripts/fetch_apex.py
"""

import hashlib
import html
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


def list_apex(source):
    """Result PDFs on an Apex Timing results page, across every class."""
    path = source["path"]
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
    docs = []
    for s in sessions:
        # "list" is a start list (not raced yet), "" not published at all.
        if not s["type"].startswith("result") or not WANTED.match(s["title"]) or SKIPPED.search(s["title"]):
            continue
        s["url"] = f"{BASE}results_download.php?pdf=" + urllib.parse.quote(f"results{path}{s['id']}.pdf", safe="")
        docs.append(s)
    return docs


# Sportity document titles carry their posting time ("Heat 3 A-B 25 Sep 2026
# 14:06 CEST"). Wanted: the combined qualifying and the heats (including
# "Revision N" re-posts); not the laptimes, start grids, warm ups, per-group
# qualifying, finals or "Ranking after Heats" (computed by the app itself).
SPORTITY_DATE = re.compile(r"\s+\d{1,2} \w{3} \d{4} \d{1,2}:\d{2}(?: \w+)?$")
SPORTITY_WANTED = re.compile(r"^(Total Qualifying Practice|Heat \d+(?: [A-Z]-[A-Z])?(?: Revision \d+)?)$", re.I)


def list_sportity(source):
    """Timing PDFs in the "<Class> Results + Groups" sections of a Sportity event."""
    _, raw = fetch(source["url"])
    page = raw.decode("utf-8", "replace")
    clean = lambda t: re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", t))).strip()
    docs = []
    class_name = None
    for m in re.finditer(r'href="#parent-[^"]+"[^>]*>(.*?)</a>|href="(https://app-cdn\.sportity\.com/[^"]+)"[^>]*>(.*?)</a>', page, re.S):
        if m.group(1) is not None:
            section = clean(m.group(1))
            r = re.match(r"^(.*?)\s+Results\b", section, re.I)
            class_name = r.group(1) if r and not re.match(r"^Championship", section, re.I) else None
            continue
        if not class_name:
            continue
        url = html.unescape(m.group(2))
        title = SPORTITY_DATE.sub("", clean(m.group(3)))
        if not SPORTITY_WANTED.match(title) or not url.lower().endswith(".pdf"):
            continue
        # Each upload gets its own UUID prefix in the file name - stable id.
        doc_id = urllib.parse.unquote(url.rsplit("/", 1)[-1])[:36]
        docs.append({"className": class_name, "id": doc_id, "title": title, "url": url.replace(" ", "%20")})
    return docs


LISTERS = {"apex": list_apex, "sportity": list_sportity}


def source_slug(source):
    if source.get("type") == "sportity":
        parts = urllib.parse.urlparse(source["url"]).path.strip("/").split("/")
        return "sportity-" + "-".join(p[:8] for p in parts[1:])
    return source["path"].strip("/").replace("/", "-")


def main():
    sources = json.loads((DATA / "sources.json").read_text())
    manifest_path = DATA / "manifest.json"
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"files": []}
    known = {f["path"]: f for f in previous.get("files", [])}

    files = []
    for source in sources:
        slug = source_slug(source)
        try:
            docs = LISTERS[source.get("type", "apex")](source)
        except Exception as e:  # keep what we had for this event if the page is down
            print(f"{slug}: kon resultatenpagina niet ophalen: {e}", file=sys.stderr)
            files.extend(f for f in known.values() if f["path"].startswith(f"data/apex/{slug}/"))
            continue

        for s in docs:
            rel = f"data/apex/{slug}/{s['id']}.pdf"
            target = ROOT / rel
            # Sportity never changes a published file (a revision is a new
            # upload), so don't download it again every minute.
            if source.get("type") == "sportity" and rel in known and target.exists():
                files.append(known[rel])
                continue
            try:
                ctype, body = fetch(s["url"])
            except Exception as e:
                print(f"{rel}: download mislukt: {e}", file=sys.stderr)
                if rel in known:
                    files.append(known[rel])
                continue
            if "pdf" not in ctype or not body.startswith(b"%PDF"):
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists() or target.read_bytes() != body:
                target.write_bytes(body)
                print(f"bijgewerkt: {rel} ({s['className']} - {s['title']})")
            files.append({
                "path": rel,
                "event": source.get("name", slug),
                "className": s["className"],
                "title": s["title"],
                "sha1": hashlib.sha1(body).hexdigest(),
            })

    manifest = {"files": files}
    if manifest != {"files": previous.get("files", [])}:
        manifest_path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
