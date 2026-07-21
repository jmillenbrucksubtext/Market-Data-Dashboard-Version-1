"""
load_university_qualifiers.py
-----------------------------
Patch the two university-screen qualifiers into data.json without an Azure SQL
refresh, the same way load_affluence.py / load_qualifiers_supply_demand.py
patch their own qualifiers:

  power4_r1   -> reads scorecard.anchor_university, classifies via
                 university_classification (Power 4 list from dashboard.js +
                 Carnegie 2025 R1 set). Pass if Power 4 OR R1.

  fwd_top50   -> reads scorecard.fwd_rank (parsed from forward-model.html by
                 export-data.py). Pass if the forward-model list rank <= 50.

Re-running is safe: each market's two entries are replaced in place (or
appended if absent) and the roll-up counters are recomputed.
"""

from __future__ import annotations

import json
from pathlib import Path

from load_affluence import recompute_rollup
from university_classification import (
    FWD_TOP50_QID,
    POWER4_R1_QID,
    forward_top50_result,
    load_power4_anchors,
    power4_r1_result,
)

DATA_JSON = Path(__file__).resolve().parent / "data.json"


def _replace_or_append(results: list[dict], new_res: dict) -> None:
    for i, r in enumerate(results):
        if r.get("id") == new_res["id"]:
            results[i] = new_res
            return
    results.append(new_res)


def patch_university_qualifiers(payload: dict) -> dict:
    tables = payload.get("tables", {})
    qualifiers = tables.get("market_qualifiers", [])
    scorecard_by_market = {r["market_key"]: r for r in tables.get("scorecard", [])}
    power4 = load_power4_anchors()

    counts = {"power4_r1_pass": 0, "fwd_top50_pass": 0, "markets": 0}
    for q in qualifiers:
        sc = scorecard_by_market.get(q["market_key"], {})
        p4r1 = power4_r1_result(sc.get("anchor_university"), power4)
        fwd = forward_top50_result(sc.get("fwd_rank"))

        results = q.get("results") or []
        _replace_or_append(results, p4r1)
        _replace_or_append(results, fwd)
        q["results"] = results
        q["total"] = len(results)
        recompute_rollup(q)

        counts["markets"] += 1
        if p4r1["status"] == "pass":
            counts["power4_r1_pass"] += 1
        if fwd["status"] == "pass":
            counts["fwd_top50_pass"] += 1
    return counts


def main() -> int:
    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    counts = patch_university_qualifiers(payload)
    DATA_JSON.write_text(
        json.dumps(payload, separators=(",", ":"), default=str),
        encoding="utf-8",
    )
    print(
        f"  {counts['markets']} markets patched",
        f"  power4_r1: {counts['power4_r1_pass']} passing",
        f"  fwd_top50: {counts['fwd_top50_pass']} passing",
        sep="\n",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
