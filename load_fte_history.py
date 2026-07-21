"""
load_fte_history.py
-------------------
Pulls per-market FTE history from dbo.MarketReports (current snapshot,
~1 year prior, 2021-22 academic-year baseline), patches data.json with the
new `fte_history` table, and refreshes the two FTE qualifiers
(fte_growth_yoy, fte_growth_2022) so the Subtext Qualifier Scorecard moves
them from N/A to live pass/fail.

This is a slim subset of export-data.py - runs in ~30s vs the full pipeline.
Use it when you want to refresh just FTE without re-running every query.

Run:
    python load_fte_history.py             # Azure AD interactive (default)
    python load_fte_history.py --auth sql  # SQL login (getpass)
    python load_fte_history.py --auth env  # SQLUSER/SQLPASSWORD env vars

Requires: ODBC Driver 18 for SQL Server, pyodbc.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path

import pyodbc

from load_affluence import patch_fte_qualifiers

HERE = Path(__file__).parent
DATA_JSON = HERE / "data.json"

SERVER = "subtextresearch.database.windows.net"
DATABASE = "StudentResearch"

FTE_HISTORY_SQL = """
WITH current_snap AS (
    SELECT
        latest.market_key,
        latest.max_snap          AS current_date_,
        mr.enr_full_time         AS current_fte
    FROM (
        SELECT market_key, MAX(snapshot_date) AS max_snap
        FROM dbo.MarketReports
        WHERE market_key IS NOT NULL AND enr_full_time IS NOT NULL
        GROUP BY market_key
    ) latest
    JOIN dbo.MarketReports mr
           ON  mr.market_key    = latest.market_key
          AND mr.snapshot_date = latest.max_snap
),
-- Anchor "prior" to the most recent snapshot whose enr_full_time DIFFERS
-- from current. IPEDS publishes annually per school, so the literal T-1yr
-- snapshot frequently still carries the prior cohort's number - comparing
-- to it returns 0% even when enrollment really did change. Compare-to-
-- last-change always lands on a meaningfully different cohort.
prior_yr AS (
    SELECT
        cs.market_key,
        mr.snapshot_date         AS prior_yr_date,
        mr.enr_full_time         AS prior_yr_fte,
        ROW_NUMBER() OVER (
            PARTITION BY cs.market_key
            ORDER BY mr.snapshot_date DESC
        ) AS rn
    FROM current_snap cs
    JOIN dbo.MarketReports mr
           ON  mr.market_key     = cs.market_key
          AND mr.enr_full_time  IS NOT NULL
          AND mr.enr_full_time  <> cs.current_fte
          AND mr.snapshot_date  <  cs.current_date_
),
y2022 AS (
    SELECT
        cs.market_key,
        mr.snapshot_date         AS y2022_date,
        mr.enr_full_time         AS y2022_fte,
        ROW_NUMBER() OVER (
            PARTITION BY cs.market_key
            ORDER BY ABS(DATEDIFF(DAY, '2022-01-01', mr.snapshot_date))
        ) AS rn
    FROM current_snap cs
    JOIN dbo.MarketReports mr
           ON  mr.market_key     = cs.market_key
          AND mr.enr_full_time  IS NOT NULL
          AND mr.snapshot_date BETWEEN '2021-07-01' AND '2022-12-31'
)
SELECT
    cs.market_key,
    cs.current_date_                 AS current_snapshot,
    cs.current_fte,
    py.prior_yr_date                 AS prior_year_snapshot,
    py.prior_yr_fte                  AS prior_year_fte,
    CASE WHEN py.prior_yr_fte > 0
         THEN CAST(cs.current_fte AS DECIMAL(18,6)) / py.prior_yr_fte - 1
         ELSE NULL END               AS yoy_fte_growth,
    y22.y2022_date                   AS baseline_2022_snapshot,
    y22.y2022_fte                    AS baseline_2022_fte,
    CASE WHEN y22.y2022_fte > 0
         THEN CAST(cs.current_fte AS DECIMAL(18,6)) / y22.y2022_fte - 1
         ELSE NULL END               AS fte_growth_since_2022,
    cs.current_date_                 AS data_as_of
FROM current_snap cs
LEFT JOIN prior_yr py
       ON py.market_key = cs.market_key AND py.rn = 1
LEFT JOIN y2022 y22
       ON y22.market_key = cs.market_key AND y22.rn = 1
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
        # Uses the Windows-logged-in user's AAD token silently. Works on
        # Entra-joined Windows boxes; the script can run unattended.
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Refresh fte_history from Azure SQL.")
    parser.add_argument(
        "--auth", choices=["aad", "sql", "env"], default="aad",
        help="Auth mode (default: aad - Azure AD interactive).",
    )
    args = parser.parse_args()

    cn = connect(args.auth)
    cur = cn.cursor()
    print("Running fte_history query ...")
    cur.execute(FTE_HISTORY_SQL)
    cols = [c[0] for c in cur.description]
    rows = [
        {col: _jsonable(val) for col, val in zip(cols, row)}
        for row in cur.fetchall()
    ]
    print(f"fetched {len(rows)} markets with FTE history")

    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    payload["tables"]["fte_history"] = rows

    counts = patch_fte_qualifiers(payload)
    print(f"fte_growth_yoy qualifier: {counts['fte_growth_yoy']} markets moved from N/A to live")
    print(f"fte_growth_2022 qualifier: {counts['fte_growth_2022']} markets moved from N/A to live")

    DATA_JSON.write_text(
        json.dumps(payload, separators=(",", ":"), default=str), encoding="utf-8"
    )
    print(f"Wrote {DATA_JSON} ({DATA_JSON.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
