"""
load_affluence.py
-----------------
Ingests the migration CSV (Affluence Data/MigrationAllRentsCurrent_*.csv),
joins it to the dashboard's campus -> market map, and writes a per-market
affluence table back into data.json.

Why standalone: the SQL refresh (export-data.py) needs Azure AD interactive
auth. This script lets us refresh just the affluence section against the
CSV the user has on disk, without re-running the full SQL pipeline.

Usage:
    python load_affluence.py                 # uses newest CSV in ../Affluence Data
    python load_affluence.py --csv path.csv  # explicit file
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

HERE = Path(__file__).parent
DATA_JSON = HERE / "data.json"
DEFAULT_CSV_DIR = HERE.parent / "Affluence Data"

# Months pooled into the affluence aggregation. Override at the CLI with
# --months "YYYY-MM,YYYY-MM". Update this list when a fresher CSV arrives
# and the team picks a new analysis window.
DEFAULT_MONTHS = ["2023-07", "2023-08"]


def newest_csv(directory: Path) -> Path:
    candidates = sorted(directory.glob("Migration*.csv"))
    if not candidates:
        raise SystemExit(f"No Migration*.csv found in {directory}")
    return candidates[-1]


def _f(value: str) -> float | None:
    if value in ("NA", "", "NaN"):
        return None
    try:
        return float(value)
    except ValueError:
        return None


def build_market_affluence(
    csv_path: Path,
    ipeds_to_market: dict[int, int],
    months: list[str] | None = None,
) -> list[dict]:
    """
    Returns one row per market_key. Aggregates by summing numerators and
    denominators across all campus IPEDS IDs mapped to the market and across
    the four cohorts (HiInc/LowInc × InState/OutState).

    If `months` is None, uses the single most recent month in the CSV.
    Otherwise, pools the listed months (e.g. ['2023-07', '2023-08']).
    """
    if months is None:
        with csv_path.open(encoding="utf-8", errors="replace") as fh:
            reader = csv.DictReader(fh)
            latest = max(row["month"] for row in reader)
        months = [latest]
    month_filter = set(months)
    window_label = ",".join(sorted(month_filter))

    per_market: dict[int, dict] = {}
    with csv_path.open(encoding="utf-8", errors="replace") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            if row["month"] not in month_filter:
                continue
            try:
                ipeds = int(row["UNIQUEID"])
            except (TypeError, ValueError):
                continue
            mk = ipeds_to_market.get(ipeds)
            if mk is None:
                continue

            agg = per_market.setdefault(mk, {
                "inc_num": 0.0, "inc_denom": 0.0,
                "state_inc_num": 0.0,
                "rent_num": 0.0, "rent_denom": 0.0,
                "n_hiinc": 0.0, "n_lowinc": 0.0,
                "n_instate": 0.0, "n_outstate": 0.0,
                "ipeds_ids": set(),
            })
            agg["ipeds_ids"].add(ipeds)

            n = _f(row["MedIncDenom"]) or 0.0
            inc_sum = _f(row["MedIncNum"]) or 0.0
            state_sum = _f(row["StateInc"]) or 0.0
            rent_sum = _f(row["RentNum"]) or 0.0
            rent_n = _f(row["RentDenom"]) or 0.0

            agg["inc_num"] += inc_sum
            agg["inc_denom"] += n
            agg["state_inc_num"] += state_sum
            agg["rent_num"] += rent_sum
            agg["rent_denom"] += rent_n

            if row["IncMark"] == "HiInc":
                agg["n_hiinc"] += n
            elif row["IncMark"] == "LowInc":
                agg["n_lowinc"] += n

            if row["InState"] == "TRUE":
                agg["n_instate"] += n
            elif row["InState"] == "FALSE":
                agg["n_outstate"] += n

    # Pass 3: derive ratios per market.
    out: list[dict] = []
    for mk, agg in per_market.items():
        total_classified = agg["n_hiinc"] + agg["n_lowinc"]
        total_state = agg["n_instate"] + agg["n_outstate"]
        mean_inc = (agg["inc_num"] / agg["inc_denom"]) if agg["inc_denom"] else None
        mean_state = (agg["state_inc_num"] / agg["inc_denom"]) if agg["inc_denom"] else None
        mean_rent = (agg["rent_num"] / agg["rent_denom"]) if agg["rent_denom"] else None
        pct_hiinc = (agg["n_hiinc"] / total_classified) if total_classified else None
        pct_outstate = (agg["n_outstate"] / total_state) if total_state else None
        premium = ((mean_inc / mean_state) - 1) if (mean_inc and mean_state) else None

        out.append({
            "market_key": mk,
            "n_students": int(agg["inc_denom"]),
            "pct_hiinc": pct_hiinc,
            "pct_outstate": pct_outstate,
            "mean_origin_income": mean_inc,
            "mean_origin_rent": mean_rent,
            "income_premium_vs_state": premium,
            "campus_count": len(agg["ipeds_ids"]),
            "data_as_of": window_label,
        })
    out.sort(key=lambda r: r["market_key"])
    return out


# Income-qualifier threshold mirrors the Subtext qualifier spec
# ("Avg income of median zipcodes above $85K"). Markets with too small a
# migration sample (<100 students) stay N/A.
INCOME_QUALIFIER_THRESHOLD = 85_000
INCOME_QUALIFIER_MIN_N = 100


def _income_qualifier_result(affluence_row: dict | None) -> dict:
    """Build a qualifier result dict for the income qualifier from an
    affluence row. Mirrors the shape produced by export-data.py's _result/_na.
    """
    qid = "income_median_zips"
    label = "Avg income of median zipcodes above $85K"
    threshold_display = "> $85,000"
    base = {
        "id": qid,
        "label": label,
        "threshold_display": threshold_display,
    }
    if not affluence_row or affluence_row.get("mean_origin_income") is None:
        return {
            **base,
            "actual_display": "—",
            "actual": None,
            "status": "na",
            "tier": "na",
            "explanation": "no migration sample",
        }
    n = affluence_row.get("n_students") or 0
    if n < INCOME_QUALIFIER_MIN_N:
        return {
            **base,
            "actual_display": "—",
            "actual": None,
            "status": "na",
            "tier": "na",
            "explanation": f"sample too small (n={n})",
        }
    inc = float(affluence_row["mean_origin_income"])
    threshold = INCOME_QUALIFIER_THRESHOLD
    passed = inc > threshold
    status = "pass" if passed else "fail"
    return {
        **base,
        "actual_display": f"${inc:,.0f}",
        "actual": inc,
        "status": status,
        "tier": status,
        "explanation": (
            f"mean origin household income across {int(n):,} students "
            f"(migration data, {affluence_row.get('data_as_of', 'unknown window')})"
        ),
    }


PRELEASE_YOY_THRESHOLD = -0.05   # pass if delta >= -5pp
PRELEASE_YOY_MARGIN = 0.01       # ±1pp warn band


def compute_prelease_yoy(velocity_rows: list[dict]) -> dict[int, dict]:
    """
    For each market_key, find the latest (cycle, week) snapshot and the same
    week in the prior cycle. Return a map:
        market_key -> {current_cycle, current_week, current_prelease,
                       prior_prelease, delta, current_as_of, prior_as_of}
    Markets without a same-week prior-cycle observation are omitted.
    """
    by_market: dict[int, dict[tuple[int, int], dict]] = {}
    for r in velocity_rows:
        mk = r.get("market_key")
        cyc = r.get("leasing_cycle")
        wk = r.get("week_of_cycle")
        pre = r.get("prelease_pct")
        if mk is None or cyc is None or wk is None or pre is None:
            continue
        by_market.setdefault(mk, {})[(int(cyc), int(wk))] = r

    out: dict[int, dict] = {}
    for mk, points in by_market.items():
        latest_cycle = max(c for (c, _w) in points)
        # Within the latest cycle, pick the highest week. Weeks 36-52 come
        # before weeks 1-35 chronologically (fall-cycle convention), but the
        # data carries data_as_of, so sort by that to be safe.
        latest_in_cycle = max(
            ((c, w) for (c, w) in points if c == latest_cycle),
            key=lambda cw: points[cw].get("data_as_of") or "",
        )
        cur = points[latest_in_cycle]
        cur_w = latest_in_cycle[1]
        prior = points.get((latest_cycle - 1, cur_w))
        if prior is None:
            continue
        delta = float(cur["prelease_pct"]) - float(prior["prelease_pct"])
        out[mk] = {
            "current_cycle": latest_cycle,
            "current_week": cur_w,
            "current_prelease": float(cur["prelease_pct"]),
            "prior_prelease": float(prior["prelease_pct"]),
            "delta": delta,
            "current_as_of": cur.get("data_as_of"),
            "prior_as_of": prior.get("data_as_of"),
        }
    return out


def _prelease_yoy_qualifier_result(yoy: dict | None) -> dict:
    qid = "prelease_lag"
    label = "Market prelease not lagging prior year by >5%"
    threshold_display = "delta ≥ −5%"
    base = {"id": qid, "label": label, "threshold_display": threshold_display}
    if not yoy:
        return {
            **base,
            "actual_display": "—",
            "actual": None,
            "status": "na",
            "tier": "na",
            "explanation": "no same-week prior-cycle observation",
        }
    delta = yoy["delta"]
    threshold = PRELEASE_YOY_THRESHOLD
    passed = delta >= threshold
    status = "pass" if passed else "fail"
    sign = "+" if delta >= 0 else ""
    cur_pct = yoy["current_prelease"] * 100
    prior_pct = yoy["prior_prelease"] * 100
    return {
        **base,
        "actual_display": f"{sign}{delta * 100:.1f}%",
        "actual": delta,
        "status": status,
        "tier": status,
        "explanation": (
            f"week {yoy['current_week']} of cycle {yoy['current_cycle']}: "
            f"{cur_pct:.1f}% vs {prior_pct:.1f}% same week in "
            f"cycle {yoy['current_cycle'] - 1}"
        ),
    }


def patch_prelease_yoy_qualifier(payload: dict) -> int:
    """Update the prelease_lag entry in each market_qualifiers row from the
    prelease_velocity table in the same payload. Returns count of markets
    moved from N/A to a real value."""
    velocity = payload.get("tables", {}).get("prelease_velocity", [])
    yoy_by_market = compute_prelease_yoy(velocity)
    qualifiers = payload.get("tables", {}).get("market_qualifiers", [])
    converted = 0
    for q in qualifiers:
        new_res = _prelease_yoy_qualifier_result(yoy_by_market.get(q["market_key"]))
        results = q.get("results") or []
        replaced = False
        for i, r in enumerate(results):
            if r.get("id") == "prelease_lag":
                was_na = r.get("status") == "na"
                results[i] = new_res
                if was_na and new_res["status"] != "na":
                    converted += 1
                replaced = True
                break
        if not replaced:
            results.append(new_res)
        q["results"] = results
        recompute_rollup(q)
    return converted


def credit_fraction(result: dict) -> float | None:
    """Per-qualifier credit ∈ [0,1] used for the weighted scorecard rollup.
    Binary qualifiers are 0 or 1; qualifiers carrying a per-component
    `breakdown` list (e.g. rent_growth_3yr — one component per trailing
    year) award fractional credit equal to the share of components passing.
    NA qualifiers return None so the caller can exclude them."""
    if result.get("status") == "na":
        return None
    breakdown = result.get("breakdown")
    if isinstance(breakdown, list) and breakdown:
        passed = sum(1 for b in breakdown if b.get("passed"))
        return passed / len(breakdown)
    return 1.0 if result.get("status") == "pass" else 0.0


def recompute_rollup(q: dict) -> None:
    """Recompute evaluable / passes / score_pct on a market_qualifiers row
    using weighted credit. `passes` becomes a float when any qualifier
    carries partial credit; the UI rounds for display."""
    results = q.get("results") or []
    evaluable = [r for r in results if r.get("status") != "na"]
    credits = [credit_fraction(r) for r in evaluable]
    weighted = sum(c for c in credits if c is not None)
    q["evaluable"] = len(evaluable)
    q["passes"] = weighted
    q["score_pct"] = (weighted / len(evaluable)) if evaluable else None


def _tier(actual, threshold, margin, direction):
    # Binary: tier always matches status. The historical pass/warn/fail
    # gradient was retired (see [[project-qualifier-patchers]]).
    if direction == "above":
        return "pass" if actual > threshold else "fail"
    if direction == "below":
        return "pass" if actual <= threshold else "fail"
    return "fail"


def _fte_yoy_qualifier_result(fte_row: dict | None) -> dict:
    base = {
        "id": "fte_growth_yoy",
        "label": "FTE growth YoY positive",
        "threshold_display": "> 0% YoY",
    }
    yoy = (fte_row or {}).get("yoy_fte_growth")
    if yoy is None:
        return {
            **base,
            "actual_display": "—", "actual": None,
            "status": "na", "tier": "na",
            "explanation": "no prior-year FTE snapshot",
        }
    yoy = float(yoy)
    cur = int(fte_row["current_fte"])
    prior = int(fte_row["prior_year_fte"])
    prior_snap = (fte_row.get("prior_year_snapshot") or "")[:10]
    sign = "+" if yoy >= 0 else ""
    status = "pass" if yoy > 0 else "fail"
    return {
        **base,
        "actual_display": f"{sign}{yoy * 100:.1f}%",
        "actual": yoy,
        "status": status,
        "tier": status,
        "explanation": (
            f"current FTE {cur:,} vs {prior:,} as of {prior_snap} "
            "(most recent snapshot with a different value)"
        ),
    }


def _fte_since_2022_qualifier_result(fte_row: dict | None) -> dict:
    base = {
        "id": "fte_growth_2022",
        "label": "FTE growth since 2022 above 3%",
        "threshold_display": "≥ 3% since 2022",
    }
    g = (fte_row or {}).get("fte_growth_since_2022")
    if g is None:
        return {
            **base,
            "actual_display": "—", "actual": None,
            "status": "na", "tier": "na",
            "explanation": "no 2021-22 FTE baseline",
        }
    g = float(g)
    cur = int(fte_row["current_fte"])
    baseline = int(fte_row["baseline_2022_fte"])
    snap = fte_row.get("baseline_2022_snapshot") or ""
    baseline_yr = snap[:4] if isinstance(snap, str) else ""
    sign = "+" if g >= 0 else ""
    return {
        **base,
        "actual_display": f"{sign}{g * 100:.1f}%",
        "actual": g,
        "status": "pass" if g > 0.03 else "fail",
        "tier": _tier(g, 0.03, 0.005, "above"),
        "explanation": f"current FTE {cur:,} vs {baseline:,} ({baseline_yr})",
    }


def patch_fte_qualifiers(payload: dict) -> dict[str, int]:
    """Update fte_growth_yoy and fte_growth_2022 entries in each
    market_qualifiers row using payload['tables']['fte_history'].
    Returns {qualifier_id: converted_from_na_count}.
    """
    fte_by_market = {
        r["market_key"]: r for r in payload.get("tables", {}).get("fte_history", [])
    }
    qualifiers = payload.get("tables", {}).get("market_qualifiers", [])
    counts = {"fte_growth_yoy": 0, "fte_growth_2022": 0}
    for q in qualifiers:
        fte_row = fte_by_market.get(q["market_key"])
        results = q.get("results") or []
        for new_res in (
            _fte_yoy_qualifier_result(fte_row),
            _fte_since_2022_qualifier_result(fte_row),
        ):
            replaced = False
            for i, r in enumerate(results):
                if r.get("id") == new_res["id"]:
                    was_na = r.get("status") == "na"
                    results[i] = new_res
                    if was_na and new_res["status"] != "na":
                        counts[new_res["id"]] += 1
                    replaced = True
                    break
            if not replaced:
                results.append(new_res)
        # Recompute roll-up since two results just changed.
        q["results"] = results
        recompute_rollup(q)
    return counts


def patch_income_qualifier(payload: dict, affluence_rows: list[dict]) -> int:
    """Update the income_median_zips entry in each market_qualifiers row using
    the fresh affluence_rows. Returns count of markets whose income qualifier
    moved from N/A to a real value.
    """
    affluence_by_market = {r["market_key"]: r for r in affluence_rows}
    qualifiers = payload.get("tables", {}).get("market_qualifiers", [])
    converted = 0
    for q in qualifiers:
        new_res = _income_qualifier_result(affluence_by_market.get(q["market_key"]))
        results = q.get("results") or []
        replaced = False
        for i, r in enumerate(results):
            if r.get("id") == "income_median_zips":
                was_na = r.get("status") == "na"
                results[i] = new_res
                if was_na and new_res["status"] != "na":
                    converted += 1
                replaced = True
                break
        if not replaced:
            results.append(new_res)
        # Recompute roll-up counters since one result just changed.
        q["results"] = results
        recompute_rollup(q)
    return converted


def main() -> int:
    parser = argparse.ArgumentParser(description="Refresh market_affluence from migration CSV.")
    parser.add_argument("--csv", type=Path, default=None,
                        help="Path to MigrationAllRents CSV. Default: newest in ../Affluence Data/.")
    parser.add_argument("--months", type=str, default=None,
                        help=f"Comma-separated YYYY-MM list to pool. "
                             f"Default: {','.join(DEFAULT_MONTHS)}. Pass 'latest' "
                             f"to use the most recent month in the CSV.")
    args = parser.parse_args()
    if args.months is None:
        months = list(DEFAULT_MONTHS)
    elif args.months.strip().lower() == "latest":
        months = None
    else:
        months = [m.strip() for m in args.months.split(",")]

    csv_path = args.csv or newest_csv(DEFAULT_CSV_DIR)
    print(f"Reading migration CSV: {csv_path.name}")

    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    campus = payload["tables"]["campus_locations"]
    ipeds_to_market: dict[int, int] = {}
    for row in campus:
        ipeds = row.get("ipeds_id")
        mk = row.get("market_key")
        if ipeds is not None and mk is not None:
            ipeds_to_market[int(ipeds)] = int(mk)
    print(f"campus_locations -> {len(ipeds_to_market)} ipeds_id -> market_key bindings")

    affluence = build_market_affluence(csv_path, ipeds_to_market, months=months)
    coverage = sum(1 for r in affluence if r["n_students"] > 0)
    window = months[0] if (months and len(months) == 1) else (
        ",".join(months) if months else "latest")
    print(f"market_affluence computed for {len(affluence)} markets "
          f"({coverage} with student count > 0) over window: {window}")

    payload["tables"]["market_affluence"] = affluence
    converted_inc = patch_income_qualifier(payload, affluence)
    print(f"income_median_zips qualifier populated; "
          f"{converted_inc} markets moved from N/A to live")
    converted_pre = patch_prelease_yoy_qualifier(payload)
    print(f"prelease_lag qualifier populated; "
          f"{converted_pre} markets moved from N/A to live")
    DATA_JSON.write_text(
        json.dumps(payload, indent=2, default=str), encoding="utf-8"
    )
    print(f"Wrote {DATA_JSON} ({DATA_JSON.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
