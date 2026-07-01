"""
Stamp per-market comp-set membership onto each property row in data.json
and refresh the comp-set rent qualifier. Pure data.json patcher - no SQL.

Comp-set definition (per market):
    Eligibility pool:
        phase = 'stable'   (stabilized only - lease-up and pipeline are
                            excluded; their product hasn't been tested yet)
        AND milesToClosestCampus IS NOT NULL
        AND milesToClosestCampus <= COMP_SET_MILES   (default 1.0)
        AND beds >= COMP_SET_MIN_BEDS                (default 150)
    Member if EITHER:
        yearBuilt >= COMP_SET_VINTAGE                (default 2020)
      OR
        ranked top COMP_SET_TOPN by avg_rent within the pool  (default 5)

The OR fallback matters: ~112 of 279 markets have zero pool properties built
in or after 2020, so the rent-comp qualifier would go N/A for them without
the top-N rescue. "Top performers" is defined as highest rent per bed
(avg_rent) within the walkable pool.

Side effects on payload['tables']:
  properties[].is_comp_set      bool   stamped on every property
  market_qualifiers[].results[ rent_compset ]  replaced using the new set
"""

from __future__ import annotations

import json
from pathlib import Path

from load_affluence import recompute_rollup

DATA_JSON = Path(__file__).resolve().parent / "data.json"

COMP_SET_MILES = 1.0
COMP_SET_VINTAGE = 2020
COMP_SET_TOPN = 5
COMP_SET_MIN_BEDS = 150   # exclude sub-scale properties from the comp set
# Stabilized only. Lease-up (and under-construction / planned) are pipeline -
# their product hasn't leased through a full cycle, so they're not comparable.
COMP_SET_PHASES = {"stable"}

RENT_COMPSET_THRESHOLD = 1000   # $/bed - pass if comp-set avg rent > this


def _eligible(p: dict) -> bool:
    if p.get("phase") not in COMP_SET_PHASES:
        return False
    b = p.get("beds")
    try:
        if b is None or float(b) < COMP_SET_MIN_BEDS:
            return False
    except (TypeError, ValueError):
        return False
    m = p.get("milesToClosestCampus")
    if m is None:
        return False
    try:
        return float(m) <= COMP_SET_MILES
    except (TypeError, ValueError):
        return False


def build_comp_set_keys(props_by_market: dict[int, list[dict]]) -> dict[int, set]:
    """For each market_key, return the set of property_keys in the comp-set."""
    out: dict[int, set] = {}
    for mk, props in props_by_market.items():
        pool = [p for p in props if _eligible(p)]
        modern_keys = {
            p["property_key"] for p in pool
            if (p.get("yearBuilt") or 0) >= COMP_SET_VINTAGE
        }
        ranked = sorted(
            [p for p in pool if p.get("avg_rent") is not None],
            key=lambda p: float(p["avg_rent"]),
            reverse=True,
        )
        top_keys = {p["property_key"] for p in ranked[:COMP_SET_TOPN]}
        out[mk] = modern_keys | top_keys
    return out


def _rent_compset_qualifier_result(comp_props: list[dict]) -> dict:
    base = {
        "id": "rent_compset",
        "label": "Comp-set rent above $1,000",
        "threshold_display": "> $1,000",
    }
    rents = [float(p["avg_rent"]) for p in comp_props if p.get("avg_rent") is not None]
    if not rents:
        return {
            **base,
            "actual_display": "-", "actual": None,
            "status": "na", "tier": "na",
            "explanation": "no comp-set properties with rent",
        }
    avg = sum(rents) / len(rents)
    status = "pass" if avg > RENT_COMPSET_THRESHOLD else "fail"
    return {
        **base,
        "actual_display": f"${avg:,.0f}",
        "actual": avg,
        "status": status,
        "tier": status,
        "explanation": f"average across {len(rents)} comp-set properties",
    }


def patch_comp_set(payload: dict) -> dict:
    tables = payload.get("tables", {})
    props = tables.get("properties", [])
    qualifiers = tables.get("market_qualifiers", [])

    props_by_market: dict[int, list[dict]] = {}
    for p in props:
        props_by_market.setdefault(p["market_key"], []).append(p)

    comp_keys_by_market = build_comp_set_keys(props_by_market)

    # Stamp is_comp_set on every property row (True / False)
    stamped = 0
    for p in props:
        key = p.get("property_key")
        in_set = key in comp_keys_by_market.get(p["market_key"], set())
        if p.get("is_comp_set") != in_set:
            stamped += 1
        p["is_comp_set"] = in_set

    # Replace rent_compset qualifier in each market_qualifiers row
    for q in qualifiers:
        mk = q["market_key"]
        comp_set_keys = comp_keys_by_market.get(mk, set())
        comp_props = [
            p for p in props_by_market.get(mk, [])
            if p["property_key"] in comp_set_keys
        ]
        new_res = _rent_compset_qualifier_result(comp_props)
        results = q.get("results") or []
        replaced = False
        for i, r in enumerate(results):
            if r.get("id") == "rent_compset":
                results[i] = new_res
                replaced = True
                break
        if not replaced:
            results.append(new_res)
        q["results"] = results
        recompute_rollup(q)

    sizes = [len(s) for s in comp_keys_by_market.values()]
    return {
        "total_properties": len(props),
        "comp_set_stamps_changed": stamped,
        "markets_with_comp_set": sum(1 for s in sizes if s > 0),
        "markets_with_empty_comp_set": sum(1 for s in sizes if not s),
        "median_comp_set_size": sorted(sizes)[len(sizes) // 2] if sizes else 0,
        "total_comp_set_members": sum(sizes),
    }


def main() -> int:
    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    stats = patch_comp_set(payload)
    DATA_JSON.write_text(
        json.dumps(payload, indent=2, default=str),
        encoding="utf-8",
    )
    for k, v in stats.items():
        print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
