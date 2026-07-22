"""
load_prelease_velocity.py
-------------------------
Standalone SQL patcher (see the load_*.py family): refreshes
tables.prelease_velocity in data.json from dbo.MarketReports and rebuilds
the prelease_lag qualifier (and roll-ups) from the new rows - no full
export-data.py run required.

Run modes (same as load_fte_history.py):
    python load_prelease_velocity.py              # Azure AD interactive
    python load_prelease_velocity.py --auth sql   # prompted SQL login
    python load_prelease_velocity.py --auth env   # SQLUSER/SQLPASSWORD env vars

Requires: ODBC Driver 17/18 for SQL Server, pyodbc.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path

import pyodbc

from load_affluence import compute_prelease_yoy, recompute_rollup

SERVER = "subtextresearch.database.windows.net"
DATABASE = "StudentResearch"
DATA_JSON = Path(__file__).resolve().parent / "data.json"

# Keep in sync with QUERIES["prelease_velocity"] in export-data.py.
QUERY = """
    WITH cycle_calc AS (
        SELECT
            mr.market_key,
            mr.snapshot_date,
            mr.prelease,
            mr.beds_tracked_by_prelease,
            CASE WHEN MONTH(mr.snapshot_date) <= 8
                 THEN YEAR(mr.snapshot_date)
                 ELSE YEAR(mr.snapshot_date) + 1 END AS leasing_cycle,
            DATEPART(ISO_WEEK, mr.snapshot_date) AS week_of_cycle
        FROM dbo.MarketReports mr
        WHERE mr.prelease IS NOT NULL
          AND mr.beds_tracked_by_prelease > 0
          AND mr.market_key IS NOT NULL
    ),
    max_cycle AS (SELECT MAX(leasing_cycle) AS yr FROM cycle_calc)
    SELECT
        cc.market_key,
        cc.leasing_cycle,
        cc.week_of_cycle,
        AVG(CAST(cc.prelease AS DECIMAL(18,6)))  AS prelease_pct,
        SUM(cc.beds_tracked_by_prelease)         AS beds_tracked,
        MAX(cc.snapshot_date)                    AS data_as_of
    FROM cycle_calc cc, max_cycle
    WHERE cc.leasing_cycle >= max_cycle.yr - 2
    GROUP BY cc.market_key, cc.leasing_cycle, cc.week_of_cycle
"""


def connect(auth: str = "aad"):
    drivers = sorted(
        [d for d in pyodbc.drivers() if d.startswith("ODBC Driver")],
        reverse=True,
    )
    if not drivers:
        sys.exit("ODBC Driver 17 or 18 for SQL Server is not installed.")
    base = (
        f"Driver={{{drivers[0]}}};"
        f"Server=tcp:{SERVER},1433;Database={DATABASE};"
        "Encrypt=yes;TrustServerCertificate=no;Connection Timeout=30;"
    )
    if auth == "integrated":
        cs = base + "Authentication=ActiveDirectoryIntegrated;"
    elif auth == "aad":
        upn = input("Your @subtextliving.com email (Azure AD UPN): ").strip()
        if not upn:
            sys.exit("No UPN provided; aborting.")
        cs = base + f"UID={upn};Authentication=ActiveDirectoryInteractive;"
    elif auth == "sql":
        uid = input("SQL username: ").strip()
        pwd = getpass.getpass("SQL password (not echoed): ")
        if not uid or not pwd:
            sys.exit("Empty username or password; aborting.")
        cs = base + f"UID={uid};PWD={pwd};"
    elif auth == "env":
        uid = os.environ.get("SQLUSER")
        pwd = os.environ.get("SQLPASSWORD")
        if not uid or not pwd:
            sys.exit("--auth env requires SQLUSER and SQLPASSWORD env vars.")
        cs = base + f"UID={uid};PWD={pwd};"
    else:
        sys.exit(f"Unknown --auth mode: {auth}")
    return pyodbc.connect(cs, timeout=30)


def _jsonable(value):
    import datetime as dt
    import decimal
    if isinstance(value, decimal.Decimal):
        f = float(value)
        return int(f) if f.is_integer() else f
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    return value


def _prelease_lag_result(yoy: dict | None) -> dict:
    """Mirror of export-data.py's _q_prelease_lag, driven off the map that
    compute_prelease_yoy() returns."""
    base = {
        "id": "prelease_lag",
        "label": "Market prelease not lagging prior year by >5%",
        "threshold_display": "delta ≥ −5%",
    }
    if not yoy:
        return {
            **base,
            "actual_display": "-", "actual": None,
            "status": "na", "tier": "na",
            "explanation": "no same-week prior-cycle observation",
        }
    delta = yoy["delta"]
    sign = "+" if delta >= 0 else ""
    status = "pass" if delta > -0.05 else "fail"
    return {
        **base,
        "actual_display": f"{sign}{delta * 100:.1f}%",
        "actual": delta,
        "status": status,
        "tier": status,
        "explanation": (
            f"week {yoy['current_week']} of cycle {yoy['current_cycle']}: "
            f"{yoy['current_prelease'] * 100:.1f}% vs "
            f"{yoy['prior_prelease'] * 100:.1f}% same week in "
            f"cycle {yoy['current_cycle'] - 1}"
        ),
    }


def patch_prelease_velocity(payload: dict, rows: list[dict]) -> dict:
    tables = payload["tables"]
    tables["prelease_velocity"] = rows
    yoy_by_market = compute_prelease_yoy(rows)

    counts = {"markets": len({r["market_key"] for r in rows}),
              "rows": len(rows), "moved_from_na": 0, "with_delta": 0}
    for q in tables.get("market_qualifiers", []):
        new_res = _prelease_lag_result(yoy_by_market.get(q["market_key"]))
        if new_res["actual"] is not None:
            counts["with_delta"] += 1
        results = q.get("results") or []
        replaced = False
        for i, r in enumerate(results):
            if r.get("id") == "prelease_lag":
                if r.get("status") == "na" and new_res["status"] != "na":
                    counts["moved_from_na"] += 1
                results[i] = new_res
                replaced = True
                break
        if not replaced:
            results.append(new_res)
        q["results"] = results
        recompute_rollup(q)
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Refresh prelease_velocity + the prelease_lag qualifier from Azure SQL.")
    parser.add_argument(
        "--auth", choices=["aad", "integrated", "sql", "env"], default="aad",
        help="Auth mode (default: aad - Azure AD interactive).",
    )
    args = parser.parse_args()

    cn = connect(args.auth)
    cur = cn.cursor()
    print("Running prelease_velocity query ...")
    cur.execute(QUERY)
    cols = [c[0] for c in cur.description]
    rows = [
        {k: _jsonable(v) for k, v in zip(cols, row)}
        for row in cur.fetchall()
    ]
    cn.close()

    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    counts = patch_prelease_velocity(payload, rows)
    # Compact separators to match export-data.py - indent=2 pushes data.json
    # past Cloudflare's 25 MiB limit and breaks the live site.
    DATA_JSON.write_text(
        json.dumps(payload, separators=(",", ":"), default=str),
        encoding="utf-8",
    )
    print(
        f"  prelease_velocity: {counts['rows']:,} rows across {counts['markets']} markets",
        f"  prelease_lag: {counts['with_delta']} markets with a YoY delta "
        f"({counts['moved_from_na']} moved from N/A)",
        sep="\n",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
