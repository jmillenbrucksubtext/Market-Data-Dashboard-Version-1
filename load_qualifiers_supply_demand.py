"""
Patch the rent_growth_3yr and uncaptured_1mi qualifiers in data.json from
data already present in the file - no SQL refresh required.

  rent_growth_3yr  → reads tables.market_history (avg_rent_per_bed by year),
                     pass if each of the last 3 trailing YoY rates is ≥ 3%.

  uncaptured_1mi   → reads tables.scorecard (enr_full_time) and
                     tables.properties (beds, milesToClosestCampus).
                     captured   = sum of beds within 1 mi / FTE
                     uncaptured = 1 - captured
                     pass if uncaptured > 30%.

Re-running is safe: each market's entry is replaced in place and the
roll-up counters (passes, evaluable, score_pct) are recomputed.
"""

from __future__ import annotations

import json
from pathlib import Path

from load_affluence import recompute_rollup

DATA_JSON = Path(__file__).resolve().parent / "data.json"


def _pass_fail(passed: bool) -> str:
    return "pass" if passed else "fail"


def _rent_growth_result(history_rows: list[dict]) -> dict:
    base = {
        "id": "rent_growth_3yr",
        "label": "YoY rent growth ≥3% for trailing 3 years",
        "threshold_display": "≥ 3% for 3 trailing years",
    }
    by_year = {
        int(r["year_"]): r.get("avg_rent_per_bed")
        for r in history_rows
        if r.get("avg_rent_per_bed") is not None
        and float(r["avg_rent_per_bed"]) > 0
    }
    if len(by_year) < 4:
        return {
            **base,
            "actual_display": "-", "actual": None,
            "status": "na", "tier": "na",
            "explanation": f"only {len(by_year)} years of non-zero rent history (need 4)",
        }
    years = sorted(by_year.keys())[-4:]
    rents = [float(by_year[y]) for y in years]
    yoys = [(rents[i] - rents[i - 1]) / rents[i - 1] for i in (1, 2, 3)]
    worst = min(yoys)
    passed = all(y >= 0.03 for y in yoys)
    breakdown = [
        {
            "label": f"{years[i - 1]}-{years[i]}",
            "year_from": years[i - 1],
            "year_to": years[i],
            "yoy": y,
            "yoy_display": f"{y * 100:+.1f}%",
            "passed": bool(y >= 0.03),
        }
        for i, y in zip((1, 2, 3), yoys)
    ]
    detail = " · ".join(f"{b['year_from']}→{b['year_to']}: {b['yoy_display']}" for b in breakdown)
    status = _pass_fail(passed)
    return {
        **base,
        "actual_display": " · ".join(b["yoy_display"] for b in breakdown),
        "actual": worst,
        "status": status,
        "tier": status,
        "breakdown": breakdown,
        "explanation": detail,
    }


def _uncaptured_result(fte, props: list[dict]) -> dict:
    base = {
        "id": "uncaptured_1mi",
        "label": "Uncaptured demand within 1 mile above 30%",
        "threshold_display": "> 30%",
    }
    if not fte:
        return {
            **base,
            "actual_display": "-", "actual": None,
            "status": "na", "tier": "na",
            "explanation": "no FTE on file",
        }
    near = [
        p for p in props
        if p.get("milesToClosestCampus") is not None
        and float(p["milesToClosestCampus"]) <= 1.0
        and p.get("beds")
    ]
    beds_1mi = sum(int(p["beds"]) for p in near)
    captured = beds_1mi / float(fte)
    uncaptured = 1.0 - captured
    status = _pass_fail(uncaptured > 0.30)
    return {
        **base,
        "actual_display": f"{uncaptured * 100:.1f}%",
        "actual": uncaptured,
        "status": status,
        "tier": status,
        "explanation": (
            f"{beds_1mi:,} PBSH beds within 1 mi of campus "
            f"({len(near)} props) vs {int(fte):,} FTE - "
            f"capture rate {captured * 100:.1f}%"
        ),
    }


def _flatten_legacy_tiers(results: list[dict]) -> int:
    """Old data.json rows carry tier='warn' for borderline metrics. The
    scorecard is now strictly binary, so collapse any non-na tier to match
    status. Returns count of rows touched."""
    changed = 0
    for r in results:
        st = r.get("status")
        if st == "na":
            new_tier = "na"
        elif st in ("pass", "fail"):
            new_tier = st
        else:
            continue
        if r.get("tier") != new_tier:
            r["tier"] = new_tier
            changed += 1
    return changed


def patch_supply_demand_qualifiers(payload: dict) -> dict:
    tables = payload.get("tables", {})
    qualifiers = tables.get("market_qualifiers", [])

    history_by_market: dict[int, list[dict]] = {}
    for r in tables.get("market_history", []):
        history_by_market.setdefault(r["market_key"], []).append(r)

    props_by_market: dict[int, list[dict]] = {}
    for p in tables.get("properties", []):
        props_by_market.setdefault(p["market_key"], []).append(p)

    fte_by_market = {
        r["market_key"]: r.get("enr_full_time")
        for r in tables.get("scorecard", [])
    }

    counts = {"rent_growth_3yr": 0, "uncaptured_1mi": 0, "tier_flattened": 0}
    for q in qualifiers:
        mk = q["market_key"]
        new_results = {
            "rent_growth_3yr": _rent_growth_result(history_by_market.get(mk, [])),
            "uncaptured_1mi": _uncaptured_result(fte_by_market.get(mk),
                                                  props_by_market.get(mk, [])),
        }
        results = q.get("results") or []
        for qid, new_res in new_results.items():
            replaced = False
            for i, r in enumerate(results):
                if r.get("id") == qid:
                    was_na = r.get("status") == "na"
                    results[i] = new_res
                    if was_na and new_res["status"] != "na":
                        counts[qid] += 1
                    replaced = True
                    break
            if not replaced:
                results.append(new_res)

        counts["tier_flattened"] += _flatten_legacy_tiers(results)

        q["results"] = results
        recompute_rollup(q)
    return counts


def main() -> int:
    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    counts = patch_supply_demand_qualifiers(payload)
    DATA_JSON.write_text(
        json.dumps(payload, separators=(",", ":"), default=str),
        encoding="utf-8",
    )
    print(
        f"  rent_growth_3yr: {counts['rent_growth_3yr']} markets moved from N/A",
        f"  uncaptured_1mi: {counts['uncaptured_1mi']} markets moved from N/A",
        f"  legacy tier rows flattened to binary: {counts['tier_flattened']}",
        sep="\n",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
