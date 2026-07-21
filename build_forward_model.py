#!/usr/bin/env python3
"""Sync forward-model.html from the data-science team's published dashboard.

The development Market Screener is authored by the data science team as a
self-contained page on SharePoint/OneDrive:

    General\\Investment\\Investment\\Research - Analysis\\Student Market Analysis
    \\Live Rankings\\2026 Rebuild\\Forward Looking Model Dashboard.html

That file is the published model. The Screener workbook next to it can hold
work-in-progress values that differ from it, so DO NOT rebuild this page from
the xlsx - copy the published dashboard instead. This script copies it in as
forward-model.html with two patches:

  * "Generated 2024" footer stamps become "Generated <source mtime date>",
    which build_acquisitions_model.py's template swap requires.
  * Prose em dashes (title, h1, callouts: " &mdash; ") become hyphens per
    house style. Table-cell "&mdash;" null markers are left alone.

Run this BEFORE export-data.py on a refresh: export-data.py parses the
forward_ranks table out of forward-model.html. A missing source file is a
soft failure (exit 0, page preserved) so the unattended weekly refresh
continues with the existing page.

Usage:
    python build_forward_model.py [--source PATH]
"""

import argparse
import datetime
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent
DEFAULT_SOURCE = Path(r"C:\Users\JakeMillenbruck\Subtext\Subtext - Documents"
                      r"\General\Investment\Investment\Research - Analysis"
                      r"\Student Market Analysis\Live Rankings\2026 Rebuild"
                      r"\Forward Looking Model Dashboard.html")
OUTPUT = REPO / "forward-model.html"

# Canonical SharePoint copy of the published dashboard, linked from both
# footers so viewers can confirm the embedded page is current.
LIVE_URL = ("https://collegiatedevelopment.sharepoint.com/sites/Subtext/"
            "Shared%20Documents/Forms/AllItems.aspx"
            "?id=%2Fsites%2FSubtext%2FShared%20Documents%2FGeneral"
            "%2FInvestment%2FInvestment%2FResearch%20%2D%20Analysis"
            "%2FStudent%20Market%20Analysis%2FLive%20Rankings"
            "%2F2026%20Rebuild%2FForward%20Looking%20Model%20Dashboard%2Ehtml"
            "&parent=%2Fsites%2FSubtext%2FShared%20Documents%2FGeneral"
            "%2FInvestment%2FInvestment%2FResearch%20%2D%20Analysis"
            "%2FStudent%20Market%20Analysis%2FLive%20Rankings"
            "%2F2026%20Rebuild&p=true")
LIVE_LINK = (f'<a class="live-src" href="{LIVE_URL}" target="_blank" '
             f'rel="noopener" style="color:#2c4a8a; font-weight:600;">'
             f'Live source on SharePoint &#8599;</a>')


def main(source: Path) -> None:
    if not source.is_file():
        print(f"build_forward_model: source not found ({source}); "
              "preserving existing forward-model.html")
        return
    page = source.read_text(encoding="utf-8")

    for anchor in ('id="tab-values"', 'id="tab-weightings"',
                   'rank-forward', '<td class="left">',
                   "Source: Screener &ndash; 2024.xlsx"):
        if anchor not in page:
            sys.exit(f"build_forward_model: ERROR: source page is missing "
                     f"expected anchor {anchor!r} - layout changed?")

    stamp = datetime.date.fromtimestamp(source.stat().st_mtime).isoformat()
    page, n = re.subn(r"Generated (?:\d{4}-\d{2}-\d{2}|\d{4})",
                      f"Generated {stamp} &nbsp;|&nbsp; {LIVE_LINK}", page)
    if n != 2:
        sys.exit(f"build_forward_model: ERROR: expected 2 'Generated' "
                 f"footer stamps, found {n}")

    page = page.replace(" &mdash; ", " - ")

    OUTPUT.write_text(page, encoding="utf-8")
    rows = len(re.findall(r'rank-forward">\d+<', page))
    print(f"build_forward_model: wrote {OUTPUT.name} from published "
          f"dashboard (modified {stamp}; {rows} ranked rows across tabs)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", type=Path, default=DEFAULT_SOURCE,
                    help="path to Forward Looking Model Dashboard.html")
    main(ap.parse_args().source)
