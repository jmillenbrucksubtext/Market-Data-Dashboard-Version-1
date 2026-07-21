"""
model_ranks.py
--------------
Shared parser for the data-science screener HTMLs:

  forward-model.html      - development forward model ("Forward Model" view)
  acquisitions-model.html - acquisitions forward model

Both are self-contained HTML drops with an identical Values-tab table, so one
parser serves both. compute_model_ranks() reads the Fwd. Rank column and
resolves each screener market name to a scorecard market_key; export-data.py
stamps the results onto the scorecard as fwd_rank / acq_rank every refresh,
and load_model_ranks.py does the same standalone (no SQL) when a new model
HTML is dropped between refreshes.

Extracted from export-data.py's compute_forward_ranks so the full pipeline
and the patcher share one implementation.
"""

from __future__ import annotations

import re
from pathlib import Path

HERE = Path(__file__).parent
FORWARD_HTML = HERE / "forward-model.html"
ACQUISITIONS_HTML = HERE / "acquisitions-model.html"

# Screener names that are shorter/variant than the dashboard's anchor name, or
# ambiguous across multiple campuses - map to the intended flagship. Values are
# canonical anchor names (resolved through the scorecard, so no hard-coded keys).
_MODEL_ALIAS = {
    "pennsylvania state university": "Penn State",
    "university at buffalo state university of new york": "University at Buffalo SUNY",
    "university of illinois urbana champaign": "University of Illinois at Urbana-Champaign",
    "university of north carolina": "University of North Carolina at Chapel Hill",
    "university of massachusetts": "University of Massachusetts Amherst",
    "indiana university": "Indiana University Bloomington",
    "university of minnesota": "University of Minnesota Twin Cities",
}


def _norm_name(s: str) -> str:
    s = (s or "").lower().replace("–", "-").replace("—", "-")
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def compute_model_ranks(scorecard: list[dict], html_path: Path) -> dict[int, int]:
    """Return {market_key: rank} parsed from a screener HTML's Values tab.

    Non-fatal: a missing or unreadable file just yields no ranks."""
    if not html_path.exists():
        print(f"  model_ranks: {html_path.name} not found (skipping)")
        return {}
    try:
        html = html_path.read_text(encoding="utf-8")
    except OSError as e:
        print(f"  model_ranks: {html_path.name} SKIPPED (read failed: {e})")
        return {}
    # Read the Values tab only, so each market is counted once.
    start, end = html.find('id="tab-values"'), html.find('id="tab-weightings"')
    section = html[start:end] if start != -1 and end != -1 else html

    anchor_to_key: dict[str, int] = {}
    city_to_key: dict[str, int] = {}
    for r in scorecard:
        anchor_to_key[_norm_name(r["anchor_university"])] = r["market_key"]
        city_to_key.setdefault(_norm_name(r["city"]), r["market_key"])

    def resolve(name: str):
        n = _norm_name(name)
        if n in _MODEL_ALIAS:                         # variant / flagship lock
            n = _norm_name(_MODEL_ALIAS[n])
        if n in anchor_to_key:                        # exact anchor
            return anchor_to_key[n]
        parts = re.split(r"\s+-\s+", name.replace("–", "-"), maxsplit=1)
        uni = _norm_name(parts[0])
        city = _norm_name(parts[1]) if len(parts) > 1 else None
        if uni in anchor_to_key:                      # "University - City" → university
            return anchor_to_key[uni]
        for a, k in anchor_to_key.items():            # single-campus prefix
            if a.startswith(n + " ") or n.startswith(a + " "):
                return k
        if city and city in city_to_key:              # city fallback
            return city_to_key[city]
        return None

    ranks: dict[int, int] = {}
    unmatched: list[str] = []
    for row in re.findall(r"<tr>(.*?)</tr>", section, re.S):
        mr = re.search(r'rank-forward">(\d+)<', row)
        mn = re.search(r'<td class="left">(.*?)</td>', row, re.S)
        if not (mr and mn):
            continue
        name = re.sub(r"<[^>]+>", "", mn.group(1)).replace("&amp;", "&").strip()
        k = resolve(name)
        if k is None:
            unmatched.append(name)
        elif k not in ranks:                          # first (Values tab) wins
            ranks[k] = int(mr.group(1))
    print(f"  model_ranks: {len(ranks)} markets ranked from {html_path.name}")
    if unmatched:
        print(f"    {len(unmatched)} screener markets not on the dashboard: "
              + "; ".join(unmatched))
    return ranks
