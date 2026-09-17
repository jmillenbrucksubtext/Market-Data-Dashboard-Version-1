"""
render_analysis_decks.py
------------------------
Render every deck registered in analysis_docs.json to slide images for the
market page's "Market Analysis" tab (a slide viewer), then refresh
tables.analysis_docs in data.json so each entry knows where its slides are.

Output, per deck:
    decks/<market_key>/<yyyymmdd of presentation_date>/
        s01.jpg ... sNN.jpg   1600px wide, JPEG q82 (~200 KB each)
        t01.jpg ... tNN.jpg   320px wide filmstrip thumbnails
        meta.json             {slides, width, height, source, source_size,
                               source_mtime, route, rendered_at}
    (Terse on purpose: the repo path is ~220 chars and Windows caps paths at 260.)

Two render routes:
    pdf   a PDF twin sits beside the .pptx (same stem) -> PyMuPDF, ~2s/deck,
          no Office needed.
    ppt   no PDF -> PowerPoint itself, invisibly, via COM (pywin32); ~10s/deck.
          Requires PowerPoint on this machine, so this script is manual /
          separate task - NOT part of the Monday export (which also must
          never trigger OneDrive cloud recalls of 50 MB decks).

Idempotent: a deck is re-rendered only when its source file's size or mtime
changed since the manifest was written (or with --force).

Usage:
    python render_analysis_decks.py                 render what's new/changed
    python render_analysis_decks.py --force         re-render everything
    python render_analysis_decks.py --market 383    one market only
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

from load_analysis_docs import (
    DECKS_DIR, HERE, deck_dir, deck_slug, load_registry, local_path, patch_data_json,
)

SLIDE_W = 1600
THUMB_W = 320
JPG_Q = 82
THUMB_Q = 70


def _source_sig(p: Path) -> tuple[int, float]:
    st = p.stat()
    return st.st_size, round(st.st_mtime, 0)


def _needs_render(entry: dict, src: Path, force: bool) -> bool:
    if force:
        return True
    mf = deck_dir(entry) / "meta.json"
    if not mf.exists():
        return True
    try:
        m = json.loads(mf.read_text(encoding="utf-8"))
        size, mtime = _source_sig(src)
        return not (m.get("source_size") == size and float(m.get("source_mtime", -1)) == mtime
                    and (deck_dir(entry) / f"s{int(m['slides']):02d}.jpg").exists())
    except Exception:  # noqa: BLE001 - any doubt -> re-render
        return True


def _make_thumbs(out: Path, n: int) -> None:
    import fitz  # PyMuPDF doubles as a fast JPEG resizer
    for i in range(1, n + 1):
        pix = fitz.Pixmap(str(out / f"s{i:02d}.jpg"))
        scale = THUMB_W / pix.width
        # Downsample via a tiny PDF page draw - avoids a Pillow dependency.
        doc = fitz.open()
        page = doc.new_page(width=pix.width * scale, height=pix.height * scale)
        page.insert_image(page.rect, pixmap=pix)
        tp = page.get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False)
        tp.save(str(out / f"t{i:02d}.jpg"), jpg_quality=THUMB_Q)
        doc.close()


def render_pdf(pdf: Path, out: Path) -> tuple[int, int, int]:
    import fitz
    doc = fitz.open(str(pdf))
    n = len(doc)
    w = h = 0
    for i, page in enumerate(doc, 1):
        z = SLIDE_W / page.rect.width
        pix = page.get_pixmap(matrix=fitz.Matrix(z, z), alpha=False)
        pix.save(str(out / f"s{i:02d}.jpg"), jpg_quality=JPG_Q)
        w, h = pix.width, pix.height
    doc.close()
    return n, w, h


def render_ppt(pptx: Path, out: Path) -> tuple[int, int, int]:
    import pythoncom
    import win32com.client
    pythoncom.CoInitialize()
    app = win32com.client.Dispatch("PowerPoint.Application")
    tmp = out / "_export"
    tmp.mkdir(exist_ok=True)
    try:
        pres = app.Presentations.Open(str(pptx), ReadOnly=True, Untitled=False, WithWindow=False)
        n = int(pres.Slides.Count)
        ratio = float(pres.PageSetup.SlideHeight) / float(pres.PageSetup.SlideWidth)
        h = int(round(SLIDE_W * ratio))
        pres.Export(str(tmp), "JPG", SLIDE_W, h)
        pres.Close()
    finally:
        try:
            app.Quit()
        except Exception:  # noqa: BLE001
            pass
    # PowerPoint names files Slide1.JPG ... SlideN.JPG (unpadded) - normalise.
    for f in tmp.iterdir():
        m = re.fullmatch(r"Slide(\d+)\.(?:JPG|jpg|jpeg)", f.name)
        if m:
            shutil.move(str(f), str(out / f"s{int(m[1]):02d}.jpg"))
    shutil.rmtree(tmp, ignore_errors=True)
    return n, SLIDE_W, h


def render_entry(entry: dict, force: bool = False) -> dict | None:
    if (entry.get("kind") or "deck") != "deck":
        return None
    src = local_path(entry["path"])
    if not src.exists():
        print(f"  SKIP (missing locally): {src}")
        return None
    out = deck_dir(entry)
    if len(str(out)) + len("/s00.jpg") > 255:
        sys.exit(f"output path too long for Windows ({len(str(out))} chars): {out}")
    if not _needs_render(entry, src, force):
        print(f"  up to date: {out.relative_to(HERE)}")
        return json.loads((out / "meta.json").read_text(encoding="utf-8"))

    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.jpg"):
        old.unlink()
    pdf_twin = src.with_suffix(".pdf")
    t0 = time.time()
    if pdf_twin.exists():
        route = "pdf"
        n, w, h = render_pdf(pdf_twin, out)
    else:
        route = "ppt"
        n, w, h = render_ppt(src, out)
    _make_thumbs(out, n)
    size, mtime = _source_sig(src)
    manifest = {
        "slides": n, "width": w, "height": h, "route": route,
        "source": entry["path"], "source_size": size, "source_mtime": mtime,
        "rendered_at": dt.datetime.now().isoformat(timespec="seconds"),
    }
    (out / "meta.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    mb = sum(f.stat().st_size for f in out.glob("*.jpg")) / 1e6
    print(f"  rendered {n} slides via {route} in {time.time() - t0:.1f}s -> "
          f"{out.relative_to(HERE)} ({mb:.1f} MB)")
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="re-render even if unchanged")
    ap.add_argument("--market", type=int, help="only this market_key")
    args = ap.parse_args()

    entries = [e for e in load_registry() if args.market is None or int(e["market_key"]) == args.market]
    if not entries:
        sys.exit("nothing to render (no matching registry entries)")
    DECKS_DIR.mkdir(parents=True, exist_ok=True)
    for e in entries:
        render_entry(e, force=args.force)
    # Refresh data.json so tables.analysis_docs picks up slide manifests.
    os.chdir(HERE)
    patch_data_json()


if __name__ == "__main__":
    main()
