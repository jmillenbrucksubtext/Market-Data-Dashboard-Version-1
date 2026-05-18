"""
fetch-campus-logos.py
---------------------
For every tracked market's anchor university in data.json, fetch its primary
infobox image from Wikipedia and save as assets/campus-logos/<market_key>.png.

Wikipedia API flow per school:
  1. Search the title:  /w/api.php?action=opensearch&search=<name>&limit=1
  2. Fetch original image URL: /w/api.php?action=query&prop=pageimages&piprop=original&titles=<title>
  3. Download the image.

Already-fetched files are skipped — re-running is safe and cheap.
A manifest is written to assets/campus-logos/_manifest.json.

Run:
    python fetch-campus-logos.py              # all scorecard markets
    python fetch-campus-logos.py --s30-only   # Subtext-30 markets only
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# Force UTF-8 stdout/stderr so Wikipedia titles with diacritics
# (e.g. "University of Hawaiʻi at Mānoa") don't blow up the cp1252
# default console on Windows.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent
OUT_DIR = ROOT / "assets" / "campus-logos"
DATA = ROOT / "data.json"
MANIFEST = OUT_DIR / "_manifest.json"

USER_AGENT = "SubtextDashboardLogoFetcher/1.1 (internal team tool; contact: it@subtextliving.com)"
WIKI_API = "https://en.wikipedia.org/w/api.php"

REQUEST_GAP = 1.5     # seconds between requests
MAX_RETRIES = 5


def http_json(url: str) -> dict:
    backoff = 2.0
    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < MAX_RETRIES - 1:
                print(f"   429 — sleeping {backoff:.0f}s")
                time.sleep(backoff)
                backoff *= 2
                continue
            raise
    raise RuntimeError("retry budget exhausted")


def http_bytes(url: str) -> bytes:
    backoff = 2.0
    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < MAX_RETRIES - 1:
                print(f"   429 — sleeping {backoff:.0f}s")
                time.sleep(backoff)
                backoff *= 2
                continue
            raise
    raise RuntimeError("retry budget exhausted")


def find_wiki_title(name: str) -> str | None:
    """Return the most likely Wikipedia title for a university name."""
    q = urllib.parse.urlencode({
        "action": "opensearch",
        "search": name,
        "limit": 5,
        "namespace": 0,
        "format": "json",
    })
    try:
        data = http_json(f"{WIKI_API}?{q}")
    except Exception as e:
        print(f"   search error: {e}")
        return None
    # opensearch returns [query, [titles], [descriptions], [urls]]
    titles = data[1] if len(data) > 1 else []
    if not titles:
        return None
    # Prefer titles that contain "University" or "College" or are exact
    for t in titles:
        if name.lower().split()[0] in t.lower() and ("university" in t.lower() or "college" in t.lower() or "institute" in t.lower()):
            return t
    return titles[0]


def find_pageimage_url(title: str) -> str | None:
    """Try pageimages first (works only for free-use images on Commons).
    Fall back to parse API → imageinfo, which works for fair-use logos too."""
    # --- attempt 1: pageimages ---
    q = urllib.parse.urlencode({
        "action": "query",
        "prop": "pageimages",
        "piprop": "thumbnail|original",
        "pithumbsize": 500,
        "titles": title,
        "format": "json",
    })
    try:
        data = http_json(f"{WIKI_API}?{q}")
    except Exception as e:
        print(f"   pageimages error: {e}")
        data = {}
    pages = data.get("query", {}).get("pages", {})
    for _, page in pages.items():
        for key in ("original", "thumbnail"):
            v = page.get(key)
            if v and v.get("source"):
                return v["source"]

    # --- attempt 2: parse API → all images on the page ---
    time.sleep(REQUEST_GAP)
    q = urllib.parse.urlencode({
        "action": "parse",
        "page": title,
        "prop": "images",
        "format": "json",
    })
    try:
        data = http_json(f"{WIKI_API}?{q}")
    except Exception as e:
        print(f"   parse error: {e}")
        return None
    images = data.get("parse", {}).get("images", [])
    if not images:
        print(f"   parse returned 0 images (raw keys: {list(data.keys())})")
        if data.get("error"):
            print(f"   parse error body: {data['error']}")
        return None
    print(f"   parse: {len(images)} images, first 3: {images[:3]}")

    # Score image filenames; prefer logo/seal/wordmark and skip generic things
    # like icons / commons-logo / aerial photos.
    def score(name: str) -> int:
        n = name.lower()
        s = 0
        if "logo" in n: s += 10
        if "wordmark" in n: s += 9
        if "seal" in n: s += 8
        if "crest" in n: s += 6
        if "athletics" in n or "athletic" in n: s += 4
        if any(x in n for x in ("commons-logo", "wiki", "padlock", "ambox", "p_vip", "icon", "edit-clear")): s -= 50
        if any(x in n for x in ("photo", "aerial", "building", "campus", "view")): s -= 5
        return s

    ranked = sorted(images, key=lambda n: score(n), reverse=True)
    candidate = next((n for n in ranked if score(n) > 0), None) or images[0]
    return resolve_file_url(candidate)


def resolve_file_url(filename: str) -> str | None:
    """Resolve a 'File:foo.png' name to its actual upload URL."""
    title = filename if filename.startswith("File:") else f"File:{filename}"
    q = urllib.parse.urlencode({
        "action": "query",
        "titles": title,
        "prop": "imageinfo",
        "iiprop": "url",
        "iiurlwidth": 500,
        "format": "json",
    })
    try:
        data = http_json(f"{WIKI_API}?{q}")
    except Exception as e:
        print(f"   imageinfo error: {e}")
        return None
    pages = data.get("query", {}).get("pages", {})
    for _, page in pages.items():
        ii = page.get("imageinfo")
        if ii and ii[0].get("thumburl"):
            return ii[0]["thumburl"]
        if ii and ii[0].get("url"):
            return ii[0]["url"]
    return None


def fetch_logo(market_key: int, university_name: str) -> dict:
    """Try to download the logo. Return a manifest entry dict."""
    print(f"[{market_key}] {university_name}")
    title = find_wiki_title(university_name)
    if not title:
        print("   no wiki page found")
        return {"market_key": market_key, "university": university_name, "status": "no_wiki_page"}
    print(f"   wiki: {title}")
    img_url = find_pageimage_url(title)
    if not img_url:
        print("   no infobox image on page")
        return {"market_key": market_key, "university": university_name, "wiki_title": title, "status": "no_image"}
    print(f"   image: {img_url}")
    try:
        data = http_bytes(img_url)
    except Exception as e:
        print(f"   download failed: {e}")
        return {"market_key": market_key, "university": university_name, "wiki_title": title, "image_url": img_url, "status": "download_failed"}
    # Save with the suffix from the URL (usually .png, .jpg, or .svg)
    ext = Path(urllib.parse.urlparse(img_url).path).suffix.lower() or ".png"
    out = OUT_DIR / f"{market_key}{ext}"
    out.write_bytes(data)
    print(f"   wrote {out.name} ({len(data) / 1024:.0f} KB)")
    return {
        "market_key": market_key,
        "university": university_name,
        "wiki_title": title,
        "image_url": img_url,
        "file": out.name,
        "status": "ok",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--s30-only", action="store_true",
                        help="Limit fetch to Subtext-30 focus markets only.")
    args = parser.parse_args()

    if not DATA.exists():
        sys.exit(f"data.json not found at {DATA}")
    payload = json.loads(DATA.read_text(encoding="utf-8"))
    targets = [
        (r["market_key"], r["anchor_university"])
        for r in payload["tables"]["scorecard"]
        if not args.s30_only or r.get("is_subtext30") == 1
    ]
    scope = "Subtext-30" if args.s30_only else "all scorecard"
    print(f"{scope} markets to process: {len(targets)}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Resume support — if a logo already exists for a market_key, skip fetch.
    existing = {p.stem: p for p in OUT_DIR.glob("*") if p.is_file() and p.name != "_manifest.json"}

    # Preserve existing manifest entries so a partial re-run keeps prior results.
    existing_manifest: dict[int, dict] = {}
    if MANIFEST.exists():
        try:
            for entry in json.loads(MANIFEST.read_text(encoding="utf-8")):
                existing_manifest[entry["market_key"]] = entry
        except (json.JSONDecodeError, KeyError):
            pass

    manifest_by_key: dict[int, dict] = dict(existing_manifest)
    for market_key, name in targets:
        if str(market_key) in existing:
            print(f"[{market_key}] {name} — already fetched ({existing[str(market_key)].name})")
            manifest_by_key[market_key] = {
                "market_key": market_key, "university": name,
                "file": existing[str(market_key)].name, "status": "ok_existing",
            }
            continue
        entry = fetch_logo(market_key, name)
        manifest_by_key[market_key] = entry
        time.sleep(REQUEST_GAP)

    manifest = sorted(manifest_by_key.values(), key=lambda e: e["market_key"])
    MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    ok = sum(1 for m in manifest if m["status"] in ("ok", "ok_existing"))
    print(f"\nDone. {ok}/{len(manifest)} logos available. Manifest: {MANIFEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
