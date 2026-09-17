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
    ppt   the .pptx itself, rendered by PowerPoint running invisibly via COM
          (pywin32); ~10s/deck. Always preferred - the deck is the source of
          truth. Requires PowerPoint on this machine, so this script is a
          manual / separate task - NOT part of the Monday export (which also
          must never trigger OneDrive cloud recalls of 50 MB decks).
    pdf   fallback only: a PDF twin beside the .pptx (same stem) -> PyMuPDF.
          Used when PowerPoint is unavailable or its export fails; warns when
          the PDF is older than the deck (they are stale exports, not twins).

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


_PPT = None  # one private PowerPoint automation instance for the whole run


def _ppt():
    """Our own hidden PowerPoint (DispatchEx = a NEW instance). Never
    Dispatch(): that attaches to whatever PowerPoint the user has open, and
    Quit() would then close their work."""
    global _PPT
    if _PPT is None:
        import pythoncom
        import win32com.client
        pythoncom.CoInitialize()
        _PPT = win32com.client.DispatchEx("PowerPoint.Application")
    return _PPT


def _ppt_quit():
    global _PPT
    if _PPT is not None:
        try:
            _PPT.Quit()
        except Exception:  # noqa: BLE001
            pass
        _PPT = None


def _hydrate(src: Path, tries: int = 3) -> None:
    """Force OneDrive to pull a Files-On-Demand placeholder down before
    PowerPoint touches it (PowerPoint's Open fails opaquely on a stub or on a
    file another process still holds). Reading the bytes is enough."""
    for attempt in range(1, tries + 1):
        try:
            with open(src, "rb") as fh:
                while fh.read(1 << 22):
                    pass
            return
        except PermissionError:
            if attempt == tries:
                raise
            print(f"  file busy/not yet local, retry {attempt}/{tries - 1} in 15s: {src.name}")
            time.sleep(15)


def render_ppt(pptx: Path, out: Path) -> tuple[int, int, int]:
    _hydrate(pptx)
    tmp = out / "_export"
    tmp.mkdir(exist_ok=True)
    pres = None
    for attempt in (1, 2):
        try:
            pres = _ppt().Presentations.Open(str(pptx), ReadOnly=True, Untitled=False, WithWindow=False)
            break
        except Exception:  # noqa: BLE001 - restart PowerPoint once and retry
            if attempt == 2:
                raise
            print("  PowerPoint Open failed - restarting the automation instance and retrying")
            _ppt_quit()
            time.sleep(5)
    try:
        n = int(pres.Slides.Count)
        ratio = float(pres.PageSetup.SlideHeight) / float(pres.PageSetup.SlideWidth)
        h = int(round(SLIDE_W * ratio))
        pres.Export(str(tmp), "JPG", SLIDE_W, h)
    finally:
        try:
            pres.Close()
        except Exception:  # noqa: BLE001
            pass
    # PowerPoint names files Slide1.JPG ... SlideN.JPG (unpadded) - normalise.
    for f in tmp.iterdir():
        m = re.fullmatch(r"Slide(\d+)\.(?:JPG|jpg|jpeg)", f.name)
        if m:
            shutil.move(str(f), str(out / f"s{int(m[1]):02d}.jpg"))
    shutil.rmtree(tmp, ignore_errors=True)
    return n, SLIDE_W, h


def _render_best(src: Path, out: Path) -> tuple[str, int, int, int]:
    """The .pptx is the source of truth: render it with PowerPoint whenever
    PowerPoint is available. A PDF twin is only a fallback (no Office on the
    machine, or the COM export failed) - PDFs beside decks are exports from
    some earlier moment and go stale as the deck is edited (Kansas: PDF dated
    07-07, deck saved 07-17, findings slide differed)."""
    pdf_twin = src.with_suffix(".pdf")
    try:
        n, w, h = render_ppt(src, out)
        return "ppt", n, w, h
    except Exception as e:  # noqa: BLE001 - fall through to the PDF
        print(f"  PowerPoint export failed ({type(e).__name__}: {e})")
        if not pdf_twin.exists():
            raise
    if pdf_twin.stat().st_mtime < src.stat().st_mtime:
        print(f"  WARNING: falling back to a PDF older than the deck "
              f"({pdf_twin.name}) - slides may be out of date")
    n, w, h = render_pdf(pdf_twin, out)
    return "pdf", n, w, h


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
    t0 = time.time()
    route, n, w, h = _render_best(src, out)
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
    failures: list[tuple[str, str]] = []
    t_all = time.time()
    try:
        for i, e in enumerate(entries, 1):
            label = f"{e.get('market', e['market_key'])} @ {e['presentation_date']}"
            print(f"[{i}/{len(entries)}] {label}")
            try:
                render_entry(e, force=args.force)
            except Exception as ex:  # noqa: BLE001 - one bad deck must not stop the batch
                msg = f"{type(ex).__name__}: {str(ex)[:160]}"
                print(f"  FAILED {label}: {msg}")
                failures.append((label, msg))
                shutil.rmtree(deck_dir(e) / "_export", ignore_errors=True)
    finally:
        _ppt_quit()
    print(f"\nDone in {(time.time() - t_all) / 60:.1f} min - {len(entries) - len(failures)} ok, {len(failures)} failed")
    for label, msg in failures:
        print(f"  FAILED {label}: {msg}")
    # Refresh data.json so tables.analysis_docs picks up slide manifests.
    os.chdir(HERE)
    patch_data_json()
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
