#!/usr/bin/env python3
"""Rebuild forward-model.html in place from the Market Screener Excel.

Reuses build_acquisitions_model.py (parsing, formatting, template swap) but
points the template AND output at forward-model.html, keeping its own title,
h1, and footer source name. Only the two <tbody> blocks and the two
"Generated <date>" stamps change.

Run this BEFORE export-data.py on a refresh: export-data.py parses the
forward_ranks table out of forward-model.html.

Usage:
    python build_forward_model.py [--xlsx PATH]
"""

import argparse
from pathlib import Path

import build_acquisitions_model as base

REPO = Path(__file__).resolve().parent
DEFAULT_XLSX = Path(r"C:\Users\JakeMillenbruck\Subtext\Subtext - Documents"
                    r"\General\Investment\Investment\Research - Analysis"
                    r"\Student Market Analysis\Live Rankings\2026 Rebuild"
                    r"\Screener - 2024.xlsx")

base.TEMPLATE = REPO / "forward-model.html"
base.OUTPUT = REPO / "forward-model.html"
base.PAGE_TITLE = "Forward Looking Model - Market Screener 2024"
base.PAGE_H1 = "Forward Looking Model - Market Screener"
base.SOURCE_NAME = "Screener &ndash; 2024.xlsx"

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--xlsx", type=Path, default=DEFAULT_XLSX,
                    help="path to Market Screener workbook")
    base.build(ap.parse_args().xlsx)
