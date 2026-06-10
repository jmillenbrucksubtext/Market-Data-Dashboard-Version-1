"""
load_enrollment_history.py
--------------------------
Pulls full per-university per-year enrollment history from
dbo.Enrollments_Manual joined to the IPEDS → market crosswalk and writes
an `enrollment_history` table into data.json. Used by the Enrollment
History charts on the Market tab (FTE, Freshman, Total).

dbo.Enrollments_Manual has duplicate (IPEDS, Year) rows in places - we
collapse with MAX(...) so one row per (IPEDS, Year). IPEDS_CH_Crosswalk
likewise has duplicate IPEDS↔market rows; deduped via DISTINCT.

Auth modes match the other patchers: --auth aad | sql | env.
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

ENROLLMENT_HISTORY_SQL = """
WITH e AS (
    SELECT IPEDS_ID,
           MIN(University)                AS university_name,
           Year,
           MAX(Total_Enrollment)          AS total_enrollment,
           MAX(Full_Time_Enrollment)      AS full_time_enrollment,
           MAX(Undergrad_Enrollment)      AS undergrad_enrollment,
           MAX(Graduate_Enrollment)       AS graduate_enrollment,
           MAX(Freshman_Enrollment)       AS freshman_enrollment
    FROM dbo.Enrollments_Manual
    WHERE Total_Enrollment > 0
    GROUP BY IPEDS_ID, Year
),
cx AS (SELECT DISTINCT IPEDs, marketKey FROM dbo.IPEDS_CH_Crosswalk)
SELECT
    e.IPEDS_ID                    AS ipeds_id,
    e.university_name,
    cx.marketKey                  AS market_key,
    e.Year                        AS year_,
    e.total_enrollment,
    e.full_time_enrollment,
    e.undergrad_enrollment,
    e.graduate_enrollment,
    e.freshman_enrollment
FROM e
LEFT JOIN cx ON cx.IPEDs = e.IPEDS_ID
WHERE e.Year >= 2015
ORDER BY e.IPEDS_ID, e.Year
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
    parser = argparse.ArgumentParser(description="Refresh enrollment_history from Azure SQL.")
    parser.add_argument("--auth", choices=["aad", "sql", "env"], default="aad")
    args = parser.parse_args()

    cn = connect(args.auth)
    cur = cn.cursor()
    print("Running enrollment_history query ...")
    cur.execute(ENROLLMENT_HISTORY_SQL)
    cols = [c[0] for c in cur.description]
    rows = [
        {col: _jsonable(val) for col, val in zip(cols, row)}
        for row in cur.fetchall()
    ]
    print(f"fetched {len(rows)} (ipeds, year) rows")

    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    payload["tables"]["enrollment_history"] = rows
    DATA_JSON.write_text(
        json.dumps(payload, indent=2, default=str), encoding="utf-8"
    )
    print(f"Wrote {DATA_JSON} ({DATA_JSON.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
