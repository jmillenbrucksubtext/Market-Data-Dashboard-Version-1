"""
load_property_prelease.py
-------------------------
Pulls a bed-weighted prelease value per property from dbo.PlanReports
(latest snapshot per property), and merges it into the `properties` table
in data.json so the comp-properties table on each market page picks up
real prelease values.

Why: dbo.Properties.prelease is null for ~99.7% of rows; dbo.PlanReports
has 6.6M rows of plan-level prelease history - the actual source. This
script aggregates the latest snapshot per property up to property level,
weighted by beds_purpose_built.

Slim subset of export-data.py: one query, ~30s.

Run:
    python load_property_prelease.py              # AAD interactive (default)
    python load_property_prelease.py --auth sql   # SQL login (getpass)
    python load_property_prelease.py --auth env   # SQLUSER/SQLPASSWORD env vars
    python load_property_prelease.py --auth integrated   # Windows AAD silent

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

HERE = Path(__file__).parent
DATA_JSON = HERE / "data.json"

SERVER = "subtextresearch.database.windows.net"
DATABASE = "StudentResearch"

PROPERTY_PRELEASE_SQL = """
WITH plan_latest AS (
    SELECT property_key, MAX(snapshot_date) AS max_snap
    FROM dbo.PlanReports
    WHERE property_key IS NOT NULL AND prelease IS NOT NULL
    GROUP BY property_key
)
SELECT
    pr.property_key,
    SUM(CAST(pr.prelease AS DECIMAL(18,6)) * pr.beds_purpose_built)
        / NULLIF(SUM(pr.beds_purpose_built), 0)        AS weighted_prelease,
    SUM(pr.beds_purpose_built)                         AS beds_in_sample,
    MAX(pr.snapshot_date)                              AS prelease_as_of
FROM dbo.PlanReports pr
JOIN plan_latest pl
       ON  pl.property_key = pr.property_key
      AND pl.max_snap      = pr.snapshot_date
WHERE pr.prelease IS NOT NULL
  AND pr.beds_purpose_built > 0
GROUP BY pr.property_key
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


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Refresh property-level prelease from PlanReports.")
    parser.add_argument(
        "--auth", choices=["aad", "integrated", "sql", "env"], default="aad",
        help="Auth mode (default: aad - Azure AD interactive).",
    )
    args = parser.parse_args()

    cn = connect(args.auth)
    cur = cn.cursor()
    print("Running property_prelease aggregation ...")
    cur.execute(PROPERTY_PRELEASE_SQL)
    cols = [c[0] for c in cur.description]
    pre_by_property: dict[int, dict] = {}
    for row in cur.fetchall():
        record = {col: _jsonable(val) for col, val in zip(cols, row)}
        pre_by_property[int(record["property_key"])] = record
    print(f"fetched prelease for {len(pre_by_property)} properties")

    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    props = payload["tables"]["properties"]
    patched = 0
    new_value = 0
    for p in props:
        pk = p.get("property_key")
        if pk is None:
            continue
        rec = pre_by_property.get(int(pk))
        if rec is None:
            continue
        # Preserve existing non-null Properties.prelease (in case it's been
        # manually curated); otherwise fill from PlanReports aggregate.
        if p.get("prelease") in (None, 0):
            p["prelease"] = rec["weighted_prelease"]
            new_value += 1
        p["prelease_as_of"] = rec["prelease_as_of"]
        patched += 1
    print(f"patched prelease_as_of on {patched} properties; "
          f"filled prelease value on {new_value} previously-null rows")

    DATA_JSON.write_text(
        json.dumps(payload, separators=(",", ":"), default=str), encoding="utf-8"
    )
    print(f"Wrote {DATA_JSON} ({DATA_JSON.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
