"""
load_property_history.py
------------------------
Pull per-property annual snapshots from dbo.PlanReports - bed-weighted
rate, rate_per_sf, occupancy, prelease - anchored to the same calendar
date pattern (latest snapshot's month/day) so YoY comparison is
apples-to-apples. Writes a new `property_history` table into data.json
that powers the Comp-set Performance time-series charts on market.html.

Auth modes match load_fte_history.py: --auth aad | sql | env.

Re-running is safe: it replaces `tables.property_history` in place.

Pattern: this is one of the [[project-qualifier-patchers]] family of slim
SQL→data.json patchers - see the memory note for context. SQL query is
also mirrored into export-data.py so the next full refresh produces the
same result.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path

import pyodbc

HERE = Path(__file__).parent
DATA_JSON = HERE / "data.json"

SERVER = "subtextresearch.database.windows.net"
DATABASE = "StudentResearch"

# Anchor: take each property's snapshot closest to the latest snapshot's
# month/day, for years 2020 onward. Then bed-weight aggregate the plan-level
# rate/occupancy/prelease values to property level.
PROPERTY_HISTORY_SQL = """
WITH la AS (
    SELECT MONTH(MAX(snapshot_date)) AS mo, DAY(MAX(snapshot_date)) AS dy
    FROM dbo.PlanReports
    WHERE property_key IS NOT NULL
),
snaps AS (
    SELECT DISTINCT
        pr.property_key,
        pr.snapshot_date,
        YEAR(pr.snapshot_date) AS yr
    FROM dbo.PlanReports pr
    WHERE pr.property_key IS NOT NULL
      AND YEAR(pr.snapshot_date) >= 2020
),
anchored AS (
    SELECT
        s.property_key, s.snapshot_date, s.yr,
        ROW_NUMBER() OVER (
            PARTITION BY s.property_key, s.yr
            ORDER BY ABS(DATEDIFF(DAY, s.snapshot_date,
                       DATEFROMPARTS(s.yr, la.mo,
                         CASE WHEN la.dy > DAY(EOMONTH(DATEFROMPARTS(s.yr, la.mo, 1)))
                              THEN DAY(EOMONTH(DATEFROMPARTS(s.yr, la.mo, 1)))
                              ELSE la.dy END)))
        ) AS rn
    FROM snaps s CROSS JOIN la
),
chosen AS (
    SELECT property_key, yr, snapshot_date FROM anchored WHERE rn = 1
)
SELECT
    pr.property_key,
    c.yr                                                       AS year_,
    c.snapshot_date                                            AS data_as_of,
    CASE WHEN SUM(pr.beds_purpose_built) > 0
         THEN SUM(pr.rate * pr.beds_purpose_built)
              / NULLIF(SUM(pr.beds_purpose_built), 0)
    END                                                        AS avg_rent_per_bed,
    CASE WHEN SUM(pr.beds_purpose_built) > 0
         THEN SUM(pr.rate_per_sf * pr.beds_purpose_built)
              / NULLIF(SUM(pr.beds_purpose_built), 0)
    END                                                        AS avg_rent_per_sf,
    CASE WHEN SUM(pr.beds_purpose_built) > 0
         THEN SUM(pr.occupancy * pr.beds_purpose_built)
              / NULLIF(SUM(pr.beds_purpose_built), 0)
    END                                                        AS occupancy,
    CASE WHEN SUM(pr.beds_purpose_built) > 0
         THEN SUM(pr.prelease * pr.beds_purpose_built)
              / NULLIF(SUM(pr.beds_purpose_built), 0)
    END                                                        AS prelease,
    SUM(pr.beds_purpose_built)                                 AS beds
FROM chosen c
JOIN dbo.PlanReports pr
       ON  pr.property_key   = c.property_key
      AND pr.snapshot_date  = c.snapshot_date
GROUP BY pr.property_key, c.yr, c.snapshot_date
ORDER BY pr.property_key, c.yr
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
    if auth == "aad":
        upn = input("Your @subtextliving.com email (Azure AD UPN): ").strip()
        if not upn:
            sys.exit("No UPN provided; aborting.")
        cs = base + f"UID={upn};Authentication=ActiveDirectoryInteractive;"
    elif auth == "sql":
        uid = input("SQL username: ").strip()
        pwd = getpass.getpass("SQL password (not echoed): ")
        cs = base + f"UID={uid};PWD={pwd};"
    elif auth == "env":
        uid = os.environ.get("SQLUSER")
        pwd = os.environ.get("SQLPASSWORD")
        if not uid or not pwd:
            sys.exit("--auth env requires SQLUSER and SQLPASSWORD env vars.")
        cs = base + f"UID={uid};PWD={pwd};"
    else:
        sys.exit(f"Unknown --auth mode: {auth}")
    return pyodbc.connect(cs, timeout=60)


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
    parser = argparse.ArgumentParser(description="Refresh property_history from Azure SQL.")
    parser.add_argument("--auth", choices=["aad", "sql", "env"], default="aad")
    args = parser.parse_args()

    cn = connect(args.auth)
    cur = cn.cursor()
    print("Running property_history query (this is heavy - ~6.6M-row scan)...")
    cur.execute(PROPERTY_HISTORY_SQL)
    cols = [c[0] for c in cur.description]
    rows = [
        {col: _jsonable(val) for col, val in zip(cols, row)}
        for row in cur.fetchall()
    ]
    print(f"fetched {len(rows)} (property_key, year) rows")

    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    payload["tables"]["property_history"] = rows

    DATA_JSON.write_text(
        json.dumps(payload, separators=(",", ":"), default=str), encoding="utf-8"
    )
    print(f"Wrote {DATA_JSON} ({DATA_JSON.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
