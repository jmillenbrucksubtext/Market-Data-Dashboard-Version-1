"""
Build a per-property unit/bed mix by bedroom type and patch it into data.json
as tables.unit_mix. Pure data.json + plans/*.json patcher - no SQL.

Source: the per-property floor-plan files in plans/<property_key>.json (the
same files property.html already consumes). Each plan row carries:
    bedrooms        real    0..12 (studios store 1 with is_studio=True)
    is_studio       bool
    beds_in_plan    int     purpose-built beds across that floor plan
    unit_type_name  str     'Studio','1br'..'12br'

Per floor plan:
    beds  = beds_in_plan                         (authoritative - reconciles
                                                   to properties.beds for ~98%
                                                   of properties within 1)
    units = beds_in_plan / bedrooms              (studios -> /1)
            Derived, since the SQL has no per-plan unit count. Summed to the
            property level this reconciles to properties.units for most
            properties; treat beds as the hard number and units as derived.

Bedroom types are bucketed Studio, 1BR..5BR, 6BR+ (the long tail of 6-12BR
town-home plans is rare and collapses into one slice for a clean chart).

Output (one row per property that has floor-plan data):
    tables.unit_mix = [
      { "property_key": int,
        "market_key": int,
        "beds_by_type":  {"Studio": n, "1BR": n, ...},   # only non-zero keys
        "units_by_type": {"Studio": n, "1BR": n, ...},
        "total_beds": n,
        "total_units": n },
      ...
    ]

Property name / phase / is_comp_set are intentionally NOT copied here - the
front end joins those from the live tables.properties row by property_key so
there is a single source of truth.

Re-running is safe: the unit_mix table is rebuilt from scratch each run.

Run:
    python load_unit_mix.py
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA_JSON = HERE / "data.json"
PLANS_DIR = HERE / "plans"

# Display order; anything 6BR or larger folds into the last bucket.
BED_TYPES = ["Studio", "1BR", "2BR", "3BR", "4BR", "5BR", "6BR+"]


def bedroom_category(plan: dict) -> str:
    """Map a floor-plan row to one of BED_TYPES."""
    if plan.get("is_studio") or str(plan.get("unit_type_name") or "").lower() == "studio":
        return "Studio"
    b = int(round(plan.get("bedrooms") or 0))
    if b <= 0:
        return "Studio"
    if b >= 6:
        return "6BR+"
    return f"{b}BR"


def units_in_plan(plan: dict) -> float:
    """Derive unit count: beds / bedrooms, studios counted one bed per unit."""
    beds = plan.get("beds_in_plan") or 0
    if not beds:
        return 0.0
    if plan.get("is_studio"):
        return float(beds)
    b = plan.get("bedrooms") or 0
    if b < 1:
        return float(beds)
    return beds / b


def has_bath_parity(plan: dict):
    """True/False if a floor plan gives every bedroom its own bath
    (bathrooms >= bedrooms); None when bath or bedroom count is missing."""
    br = plan.get("bedrooms")
    ba = plan.get("bathrooms")
    if br is None or ba is None:
        return None
    return float(ba) >= max(float(br), 1.0)


def mix_for_property(plans: list[dict]) -> dict:
    beds_by_type: dict[str, float] = {}
    units_by_type: dict[str, float] = {}
    # Average unit size (sf) per bedroom type, weighted by units so the mean
    # reflects the actual unit stock. Plans with no usable area_sf (~16%) are
    # left out of the average for their type.
    sqft_raw: dict[str, dict[str, float]] = {}
    # Bed/bath parity per bedroom type: full = every bedroom has its own bath.
    # Plans missing a bath/bedroom count (~0.05%) are dropped from parity.
    parity_raw: dict[str, dict[str, float]] = {}
    for p in plans:
        cat = bedroom_category(p)
        beds = p.get("beds_in_plan") or 0
        units = units_in_plan(p)
        beds_by_type[cat] = beds_by_type.get(cat, 0.0) + beds
        units_by_type[cat] = units_by_type.get(cat, 0.0) + units
        area = p.get("area_sf")
        if area and float(area) > 0 and units > 0:
            slot = sqft_raw.setdefault(cat, {"sf": 0.0, "units": 0.0})
            slot["sf"] += float(area) * units
            slot["units"] += units
        par = has_bath_parity(p)
        if par is None:
            continue
        bucket = "full" if par else "partial"
        slot = parity_raw.setdefault(
            cat, {"beds_full": 0.0, "beds_partial": 0.0,
                  "units_full": 0.0, "units_partial": 0.0})
        slot[f"beds_{bucket}"] += beds
        slot[f"units_{bucket}"] += units

    # Round to clean integers for display; drop empty slices.
    beds = {k: int(round(v)) for k, v in beds_by_type.items() if round(v) > 0}
    units = {k: int(round(v)) for k, v in units_by_type.items() if round(v) > 0}
    parity_by_type = {
        t: {k: int(round(v)) for k, v in parity_raw[t].items()}
        for t in BED_TYPES if t in parity_raw
        and any(round(v) > 0 for v in parity_raw[t].values())
    }
    # Units-weighted average unit size per type; drop types with no area data.
    sqft_by_type = {
        t: int(round(sqft_raw[t]["sf"] / sqft_raw[t]["units"]))
        for t in BED_TYPES
        if t in sqft_raw and sqft_raw[t]["units"] > 0
    }
    return {
        "beds_by_type": {k: beds[k] for k in BED_TYPES if k in beds},
        "units_by_type": {k: units[k] for k in BED_TYPES if k in units},
        "total_beds": sum(beds.values()),
        "total_units": sum(units.values()),
        "parity_by_type": parity_by_type,
        "sqft_by_type": sqft_by_type,
    }


def build_unit_mix(payload: dict) -> list[dict]:
    market_by_property = {
        p["property_key"]: p.get("market_key")
        for p in payload["tables"]["properties"]
    }
    rows: list[dict] = []
    missing = 0
    for prop_key, market_key in market_by_property.items():
        fp = PLANS_DIR / f"{prop_key}.json"
        if not fp.exists():
            missing += 1
            continue
        try:
            plans = json.loads(fp.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            missing += 1
            continue
        if not plans:
            missing += 1
            continue
        mix = mix_for_property(plans)
        if mix["total_beds"] == 0 and mix["total_units"] == 0:
            continue
        rows.append({"property_key": prop_key, "market_key": market_key, **mix})
    rows.sort(key=lambda r: (r["market_key"] or 0, -r["total_beds"]))
    if missing:
        print(f"  {missing} properties had no usable floor-plan file (skipped)")
    return rows


def main() -> int:
    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    rows = build_unit_mix(payload)
    payload["tables"]["unit_mix"] = rows

    markets = {r["market_key"] for r in rows}
    total_beds = sum(r["total_beds"] for r in rows)
    total_units = sum(r["total_units"] for r in rows)

    DATA_JSON.write_text(
        json.dumps(payload, indent=2, default=str), encoding="utf-8"
    )
    print(
        f"unit_mix: {len(rows)} properties across {len(markets)} markets",
        f"  {total_beds:,} beds · {total_units:,} units (derived)",
        f"Wrote {DATA_JSON} ({DATA_JSON.stat().st_size / 1024:.0f} KB)",
        sep="\n",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
