"""
load_analysis_docs.py
---------------------
Registry of market-analysis artifacts (PowerPoint decks, later workbooks /
PDFs) that live in the team's OneDrive market folders, surfaced as "Open
deck" links inside each market page's "Last analyzed" dropdown.

Source of truth is analysis_docs.json in this folder - a hand-curated list,
one entry per artifact:

    market_key         dashboard market (scorecard.market_key)
    presentation_date  ISO date of the schedule row the artifact belongs to
                       (market.js joins on market_key + this date, so it must
                       equal the row's Presentation Date, NOT the file date)
    kind               "deck" | "workbook" | "pdf"
    title              short label shown on the link
    analyst            initials (informational)
    file_date          date embedded in the filename (informational)
    path               path RELATIVE TO THE ONEDRIVE SYNC ROOT, forward slashes

The sync root is a SharePoint library, so every local file has a web twin:
    local : C:\\Users\\<you>\\Subtext\\Subtext - Documents\\<path>
    web   : https://collegiatedevelopment.sharepoint.com/sites/Subtext/Shared Documents/<path>
The dashboard is served over https, where file:// links are blocked, so the
link points at the web URL (opens in PowerPoint Online / the desktop app for
anyone signed into the tenant). The local path travels along for display.

Usage:
    python load_analysis_docs.py
        Rebuild tables.analysis_docs in data.json from analysis_docs.json.
    python load_analysis_docs.py --add "<local pptx path>" --market 383 --date 2026-07-17 [--title "..."]
        Append an entry (derives relative path, analyst initials and file
        date from the filename), then rebuild data.json.

Slide images for the Market Analysis tab: see render_analysis_decks.py
(decks/<market_key>/<yyyymmdd>/sNN.jpg, tNN.jpg, meta.json).

Also called by export-data.py each weekly refresh (build_analysis_docs), so
the table survives the Monday rebuild. Never edit data.json by hand.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).parent
DATA_JSON = HERE / "data.json"
REGISTRY = HERE / "analysis_docs.json"

# OneDrive sync root <-> SharePoint library (from
# HKCU\Software\SyncEngines\Providers\OneDrive\*: MountPoint / UrlNamespace).
SYNC_ROOT = Path(r"C:\Users\JakeMillenbruck\Subtext\Subtext - Documents")
WEB_ROOT = "https://collegiatedevelopment.sharepoint.com/sites/Subtext/Shared%20Documents/"

KIND_BY_EXT = {
    ".pptx": "deck", ".ppt": "deck",
    ".xlsx": "workbook", ".xlsm": "workbook", ".xls": "workbook",
    ".pdf": "pdf", ".docx": "memo", ".doc": "memo",
}


def web_url(rel_path: str) -> str:
    """SharePoint URL for a sync-root-relative path (segments percent-encoded,
    slashes kept)."""
    return WEB_ROOT + quote(rel_path.replace("\\", "/"), safe="/()',&+=-_.!~*")


def local_path(rel_path: str) -> Path:
    return SYNC_ROOT / rel_path.replace("/", "\\")


# Slide images live at decks/<market_key>/<yyyymmdd>/sNN.jpg (+ tNN.jpg thumbs,
# meta.json). Deliberately terse: this repo sits ~220 characters deep in
# OneDrive and Windows still enforces a 260-character path limit, so a
# descriptive slug pushed the first render past it.
DECKS_DIR = HERE / "decks"


def deck_slug(entry: dict) -> str:
    """Folder name per deck: the presentation date as yyyymmdd (one deck per
    market per presentation date; a second deck on the same date must be
    given a different presentation_date in the registry)."""
    return str(entry["presentation_date"]).replace("-", "")


def deck_dir(entry: dict) -> Path:
    return DECKS_DIR / str(int(entry["market_key"])) / deck_slug(entry)


def slides_info(entry: dict) -> dict | None:
    """Slide manifest written by render_analysis_decks.py, or None if the deck
    has not been rendered. `dir` is site-relative (what market.js fetches)."""
    mf = deck_dir(entry) / "meta.json"
    if not mf.exists():
        return None
    try:
        m = json.loads(mf.read_text(encoding="utf-8"))
        return {
            "dir": deck_dir(entry).relative_to(HERE).as_posix(),
            "count": int(m["slides"]),
            "width": m.get("width"),
            "height": m.get("height"),
            "route": m.get("route"),
            "rendered_at": m.get("rendered_at"),
        }
    except Exception:  # noqa: BLE001 - a bad manifest just means "no slides"
        return None


def load_registry() -> list[dict]:
    if not REGISTRY.exists():
        return []
    return json.loads(REGISTRY.read_text(encoding="utf-8"))


def build_analysis_docs(verbose: bool = True) -> list[dict]:
    """Registry -> data.json rows. Adds url / local_path / exists, and warns
    (never fails) when a registered file is missing locally - the web link
    may still work if the file moved only on someone else's sync."""
    rows: list[dict] = []
    for e in load_registry():
        rel = str(e["path"]).replace("\\", "/").lstrip("/")
        lp = local_path(rel)
        exists = lp.exists()
        if verbose and not exists:
            print(f"  WARNING analysis_docs: file not found locally - {lp}")
        rows.append({
            "market_key": int(e["market_key"]),
            "market": e.get("market"),
            "presentation_date": e["presentation_date"],
            "kind": e.get("kind") or KIND_BY_EXT.get(lp.suffix.lower(), "file"),
            "title": e.get("title") or lp.stem,
            "analyst": e.get("analyst"),
            "file_date": e.get("file_date"),
            "filename": lp.name,
            "path": rel,
            "local_path": str(lp),
            "url": web_url(rel),
            "exists": exists,
            "slides": slides_info(e) if (e.get("kind") or KIND_BY_EXT.get(lp.suffix.lower())) == "deck" else None,
        })
    rows.sort(key=lambda r: (r["market_key"], r["presentation_date"], r["title"]))
    if verbose:
        rendered = sum(1 for r in rows if r.get("slides"))
        print(f"  analysis_docs: {len(rows)} artifact(s) across "
              f"{len({r['market_key'] for r in rows})} market(s), {rendered} with slides  ({REGISTRY.name})")
    return rows


def patch_data_json(data_path: Path = DATA_JSON) -> list[dict]:
    if not data_path.exists():
        sys.exit(f"data.json not found at {data_path}")
    rows = build_analysis_docs()
    payload = json.loads(data_path.read_text(encoding="utf-8"))
    payload.setdefault("tables", {})["analysis_docs"] = rows
    data_path.write_text(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )
    return rows


def add_entry(local: str, market_key: int, presentation_date: str, title: str | None) -> dict:
    """Register one artifact from its local path; derives the rest."""
    lp = Path(local)
    if not lp.exists():
        sys.exit(f"file not found: {lp}")
    try:
        rel = lp.resolve().relative_to(SYNC_ROOT.resolve()).as_posix()
    except ValueError:
        sys.exit(f"{lp} is not under the OneDrive sync root {SYNC_ROOT}")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", presentation_date):
        sys.exit("--date must be YYYY-MM-DD (the schedule row's Presentation Date)")

    m_date = re.search(r"(20\d{2})(\d{2})(\d{2})", lp.stem)
    file_date = f"{m_date[1]}-{m_date[2]}-{m_date[3]}" if m_date else None
    m_init = re.search(r"\b([A-Z]{2,3})(?:\s*[+&]\s*[A-Z]{2,3})*$", lp.stem.strip())
    analyst = m_init[1] if m_init else None

    data = json.loads(DATA_JSON.read_text(encoding="utf-8")) if DATA_JSON.exists() else {}
    market = next((r.get("anchor_university") for r in data.get("tables", {}).get("scorecard", [])
                   if r.get("market_key") == market_key), None)

    entry = {
        "market_key": market_key,
        "market": market,
        "presentation_date": presentation_date,
        "kind": KIND_BY_EXT.get(lp.suffix.lower(), "file"),
        "title": title or lp.stem,
        "analyst": analyst,
        "file_date": file_date,
        "path": rel,
    }
    reg = load_registry()
    if any(e["path"].replace("\\", "/") == rel for e in reg):
        sys.exit(f"already registered: {rel}")
    reg.append(entry)
    REGISTRY.write_text(json.dumps(reg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"  registered {lp.name} -> market {market_key} ({market}) @ {presentation_date}")
    return entry


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--add", metavar="LOCAL_PATH", help="register an artifact by its local OneDrive path")
    ap.add_argument("--market", type=int, help="dashboard market_key (with --add)")
    ap.add_argument("--date", help="schedule Presentation Date YYYY-MM-DD (with --add)")
    ap.add_argument("--title", help="link label (with --add; defaults to the filename)")
    args = ap.parse_args()
    if args.add:
        if args.market is None or not args.date:
            ap.error("--add requires --market and --date")
        add_entry(args.add, args.market, args.date, args.title)
    patch_data_json()


if __name__ == "__main__":
    main()
