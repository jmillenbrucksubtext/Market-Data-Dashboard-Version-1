"""
sync_analysis_decks.py
----------------------
Keep the Market Analysis tab current with the Market Analysis Schedule.

Trigger model: an analysis moves from "upcoming" to "completed" when its
Presentation Date on the schedule passes. For every schedule row presented
within the last --lookback days (default 60, so a deck that lands late is
still caught on a later run), this script:

  1. resolves the row's market (schedule-resolver.js - the same alias table
     the dashboard uses - run through node),
  2. looks up that market's OneDrive folder in market_folders.json,
  3. scans the folder for the newest Market Analysis PowerPoint
     (Market Analysis / Market Overview / MarketAnalysis / Market Update
     names; NEVER Market Depth Analysis, per Jake 2026-09-17; Old/ folders,
     templates, transition material, submarket and summary decks excluded),
  4. if that deck is newer than the one registered for the market (or none
     is), registers it in analysis_docs.json against the row's Presentation
     Date - one deck per market, the older entry and its slides are removed,
  5. renders new or changed decks (render_analysis_decks.py - PowerPoint COM,
     so this must run on a machine with PowerPoint while the user is logged
     on; the weekly Scheduled Task runs interactively) and patches
     tables.analysis_docs in data.json.

A deck that was re-saved without a new filename is handled by the renderer's
size/mtime check, so "updated PowerPoint" also flows through here.

Runs from: load_market_schedule.py (after every schedule patch, unless
--no-decks), weekly-refresh.ps1 (after export-data.py, non-fatal, with a
time budget), or by hand:

    python sync_analysis_decks.py                 recent schedule rows only
    python sync_analysis_decks.py --dry-run       show what would change
    python sync_analysis_decks.py --all-markets   every mapped market, ignore the schedule window
    python sync_analysis_decks.py --market 383    one market
    python sync_analysis_decks.py --no-render     registry + data.json only

Markets whose folder is unknown are listed at the end - add them to
market_folders.json (folder name under General\\Markets) and rerun.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from load_analysis_docs import (
    DATA_JSON, HERE, REGISTRY, SYNC_ROOT, deck_dir, load_registry, local_path, patch_data_json,
)

MARKETS_ROOT = SYNC_ROOT / "General" / "Markets"
FOLDER_MAP = HERE / "market_folders.json"

# Deck-name rules (keep in sync with the 2026-09-17 batch selection).
INCLUDE = re.compile(r"market[\s_]*analysis|market[\s_]*overview|marketanalysis|market[\s_]*update", re.I)
EXCLUDE = re.compile(r"depth|\bold\b|submarket|site\s*#|milestone|transition|capital|recap|offer|proforma|pricing|template|summary|zoning|\(claude\)|approvalmemo|~\$", re.I)
OLD_DIR = re.compile(r"^(?:x+\.?\s*|z\.\s*|xxx\.)?old$", re.I)
SKIP_TOP_DIRS = ("C. Development", "D. Construction")


# ---------------------------------------------------------------- helpers
def file_date(stem: str, mtime: float) -> tuple[str, bool]:
    """Date embedded in the filename (tolerating 9-digit typos), else mtime."""
    m = re.search(r"(20\d{6})\d?", stem)
    if m:
        y, mo, d = int(m[1][:4]), int(m[1][4:6]), int(m[1][6:8])
        try:
            return dt.date(y, mo, d).isoformat(), True
        except ValueError:
            pass
    return dt.date.fromtimestamp(mtime).isoformat(), False


def initials(stem: str) -> str | None:
    m = re.search(r"\b([A-Z]{2,3})(?:\s*[+&]\s*[A-Z]{2,3})*(?:\s+v\d+)?$", stem.strip())
    return m[1] if m else None


def short_name(anchor: str) -> str:
    return re.sub(r" University$", "", re.sub(r"^University of ", "", anchor))


def load_folder_map() -> dict[int, dict]:
    if not FOLDER_MAP.exists():
        return {}
    return {int(r["market_key"]): r for r in json.loads(FOLDER_MAP.read_text(encoding="utf-8"))}


def resolved_schedule(data: dict) -> list[dict]:
    """Schedule rows with market_key attached, via the shared JS resolver.
    Returns [] (and says so) when node is unavailable."""
    js = r"""
const fs=require('fs'),vm=require('vm');
const ctx={window:{}};vm.createContext(ctx);
vm.runInContext(fs.readFileSync('schedule-resolver.js','utf8'),ctx);
const S=ctx.window.SubtextSchedule;
const DATA=JSON.parse(fs.readFileSync('data.json','utf8'));S.buildIndex(DATA);
const out=[];for(const r of S.rows(DATA)){const m=S.resolve(r.market_name);
 if(m)out.push({market_key:m.market_key,market:m.name,date:r.initial_analysis_date,analyst:r.analyst,type:r.analysis_type,name:r.market_name});}
process.stdout.write(JSON.stringify(out));
"""
    try:
        res = subprocess.run(["node", "-e", js], cwd=HERE, capture_output=True, text=True, timeout=120, check=True)
        return json.loads(res.stdout)
    except FileNotFoundError:
        print("  node not found - cannot resolve schedule rows to markets; skipping deck sync")
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError) as e:
        print(f"  schedule resolution failed ({type(e).__name__}); skipping deck sync")
    return []


def scan_folder(folder: Path, exclude: str | None = None) -> list[dict]:
    """Every Market Analysis deck in a market folder, newest first. `exclude`
    is an optional per-market regex from market_folders.json (e.g. "PITT" for
    the Pittsburgh deck misfiled in the USC folder)."""
    out = []
    extra = re.compile(exclude, re.I) if exclude else None
    for p in folder.rglob("*.pptx"):
        rel = p.relative_to(folder)
        parts = rel.parts[:-1]
        if any(OLD_DIR.match(x) for x in parts) or any(x.startswith(SKIP_TOP_DIRS) for x in parts):
            continue
        if len(parts) > 4 or p.name.startswith("~$"):
            continue
        if not INCLUDE.search(p.name) or EXCLUDE.search(p.name):
            continue
        if extra and extra.search(p.name):
            continue
        st = p.stat()
        fd, dated = file_date(p.stem, st.st_mtime)
        out.append({"path": p, "date": fd, "dated": dated, "mtime": st.st_mtime})
    out.sort(key=lambda c: (c["date"], c["mtime"]), reverse=True)
    return out


def pick_presentation(rows: list[dict], fdate: str) -> tuple[str, dict | None]:
    """Schedule row presented -3..+45 days from the file date (nearest)."""
    f = dt.date.fromisoformat(fdate)
    best = None
    for r in rows:
        try:
            d = dt.date.fromisoformat(str(r["date"])[:10])
        except (TypeError, ValueError):
            continue
        delta = (d - f).days
        if -3 <= delta <= 45 and (best is None or abs(delta) < abs(best[0])):
            best = (delta, d.isoformat(), r)
    return (best[1], best[2]) if best else (fdate, None)


# ---------------------------------------------------------------- main
def sync(lookback_days: int, all_markets: bool, only_market: int | None, dry_run: bool,
         render: bool, budget_min: float) -> int:
    t0 = time.time()
    data = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    anchors = {r["market_key"]: r["anchor_university"] for r in data["tables"]["scorecard"]}
    fmap = load_folder_map()
    registry = load_registry()
    by_market = {int(e["market_key"]): e for e in registry if (e.get("kind") or "deck") == "deck"}

    sched = resolved_schedule(data)
    rows_by_market: dict[int, list[dict]] = {}
    for r in sched:
        rows_by_market.setdefault(int(r["market_key"]), []).append(r)

    today = dt.date.today()
    since = today - dt.timedelta(days=lookback_days)
    if only_market:
        candidates = {only_market}
    elif all_markets:
        candidates = {mk for mk, m in fmap.items() if m.get("folder")}
    else:
        candidates = set()
        for r in sched:
            try:
                d = dt.date.fromisoformat(str(r["date"])[:10])
            except (TypeError, ValueError):
                continue
            if since <= d <= today:
                candidates.add(int(r["market_key"]))
    print(f"  {len(candidates)} market(s) to check "
          f"({'all mapped' if all_markets else f'schedule rows presented {since} .. {today}'})")

    unmapped, added, unchanged, missing, awaiting = [], [], [], [], []
    for mk in sorted(candidates, key=lambda k: anchors.get(k, str(k))):
        name = anchors.get(mk, f"market {mk}")
        folder_name = (fmap.get(mk) or {}).get("folder")
        if not folder_name:
            unmapped.append(name)
            continue
        folder = MARKETS_ROOT / folder_name
        if not folder.exists():
            unmapped.append(f"{name} (folder missing: {folder_name})")
            continue
        decks = scan_folder(folder, (fmap.get(mk) or {}).get("exclude"))
        if not decks:
            missing.append(name)
            continue
        newest = decks[0]
        rel = newest["path"].resolve().relative_to(SYNC_ROOT.resolve()).as_posix()
        current = by_market.get(mk)
        if current and current["path"].replace("\\", "/") == rel:
            unchanged.append(name)
            continue
        if current and str(current.get("file_date") or "") >= newest["date"]:
            unchanged.append(f"{name} (registered deck is newer or same date)")
            continue
        pres, row = pick_presentation(rows_by_market.get(mk, []), newest["date"])
        # "Upcoming -> completed" is the trigger: a deck whose matching
        # presentation is still in the future waits for that date to pass,
        # and in schedule mode a deck with no schedule row at all is not
        # registered automatically (use --all-markets / --market for those).
        if pres > today.isoformat():
            awaiting.append(f"{name} (scheduled {pres})")
            continue
        if row is None and not (all_markets or only_market):
            awaiting.append(f"{name} (deck dated {newest['date']} has no schedule row)")
            continue
        entry = {
            "market_key": mk, "market": name, "presentation_date": pres, "kind": "deck",
            "title": f"Market Analysis - {short_name(name)} ({dt.date.fromisoformat(newest['date']).strftime('%B %Y')})",
            "analyst": initials(newest["path"].stem) or (row or {}).get("analyst"),
            "file_date": newest["date"], "path": rel,
        }
        added.append((entry, current))
        print(f"  NEW  {name}: {newest['path'].name} (file {newest['date']}, presented {pres}"
              f"{'' if row else ', no schedule row'})" + (f"  replaces {Path(current['path']).name}" if current else ""))

    if not added:
        print("  no new Market Analysis decks")
    if dry_run:
        _summary(unmapped, missing, unchanged, awaiting)
        return 0

    # Apply: replace the market's older entry, drop its slides.
    for entry, current in added:
        if current:
            registry = [e for e in registry if e is not current]
            shutil.rmtree(deck_dir(current), ignore_errors=True)
        registry.append(entry)
    if added:
        registry.sort(key=lambda e: (e["market_key"], e["presentation_date"]))
        REGISTRY.write_text(json.dumps(registry, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"  registry updated: {len(added)} deck(s)")

    rendered = failed = skipped = 0
    if render:
        from render_analysis_decks import _ppt_quit, render_entry
        try:
            # New entries first, then anything else whose source changed.
            order = [e for e, _ in added] + [e for e in registry if e not in [a for a, _ in added]]
            for e in order:
                if (time.time() - t0) / 60 > budget_min:
                    skipped += 1
                    continue
                try:
                    mf = deck_dir(e) / "meta.json"
                    prev = mf.read_text(encoding="utf-8") if mf.exists() else None
                    render_entry(e)  # no-op when the source is unchanged
                    if mf.exists() and mf.read_text(encoding="utf-8") != prev:
                        rendered += 1
                except Exception as ex:  # noqa: BLE001
                    failed += 1
                    print(f"  RENDER FAILED {e.get('market')}: {type(ex).__name__}: {str(ex)[:140]}")
        finally:
            _ppt_quit()
        if skipped:
            print(f"  time budget ({budget_min:.0f} min) reached - {skipped} deck(s) deferred to the next run")
    patch_data_json()
    _summary(unmapped, missing, unchanged, awaiting)
    print(f"  deck sync done in {(time.time() - t0) / 60:.1f} min: {len(added)} new, {rendered} rendered, {failed} failed")
    return 1 if failed else 0


def _summary(unmapped, missing, unchanged, awaiting):
    if unchanged:
        print(f"  up to date: {len(unchanged)} market(s)")
    if awaiting:
        print(f"  waiting on the schedule: {'; '.join(awaiting)}")
    if missing:
        print(f"  folder has no Market Analysis deck: {', '.join(missing)}")
    if unmapped:
        print(f"  NO FOLDER MAPPING (add to market_folders.json): {', '.join(unmapped)}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lookback", type=int, default=60, help="days back from today to treat a schedule row as recently completed")
    ap.add_argument("--all-markets", action="store_true", help="check every mapped market, ignoring the schedule window")
    ap.add_argument("--market", type=int, help="check one market_key only")
    ap.add_argument("--dry-run", action="store_true", help="report only; change nothing")
    ap.add_argument("--no-render", action="store_true", help="update registry + data.json but do not render slides")
    ap.add_argument("--budget-min", type=float, default=12.0, help="stop rendering after this many minutes (rest next run)")
    a = ap.parse_args()
    sys.exit(sync(a.lookback, a.all_markets, a.market, a.dry_run, not a.no_render, a.budget_min))


if __name__ == "__main__":
    main()
