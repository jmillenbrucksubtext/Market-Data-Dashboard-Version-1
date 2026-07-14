"""
load_university_info.py
------------------------
SUPERSEDED 2026-07-14: university_info is exported by export-data.py from
the dbo.Enrollments view (+ dbo.Schools identity). dbo.Schools_Denormal,
which this standalone patcher still queries, was flagged DO NOT USE the
same day. Keep for reference only.

Pulls per-school institutional stats from dbo.Schools_Denormal - on-campus
bed counts, tuition, admissions funnel, on-campus housing rates, and the
student profile - and writes a `university_info` table into data.json.
Drives the University Information tab on the market page.

Schools_Denormal is school x year; we keep one row per (marketKey,
schoolKey) - the latest enrollmentYear with enrollment > 0. Zeros in rate /
income columns mean "not reported" and are treated as missing by the UI.

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

UNIVERSITY_INFO_SQL = """
WITH ranked AS (
    SELECT sd.*,
           ROW_NUMBER() OVER (
               PARTITION BY sd.marketKey, sd.schoolKey
               ORDER BY sd.enrollmentYear DESC
           ) AS rn
    FROM dbo.Schools_Denormal sd
    WHERE sd.marketKey IS NOT NULL
      AND COALESCE(sd.enrollmentTotal, 0) > 0
)
SELECT
    sd.marketKey                                   AS market_key,
    sd.schoolKey                                   AS school_key,
    sd.name                                        AS university_name,
    sd.shortName                                   AS short_name,
    sd.isPublic                                    AS is_public,
    sd.enrollmentYear                              AS enrollment_year,
    sd.enrollmentTotal                             AS enrollment_total,
    sd.enrollmentFullTimeUndergraduate             AS enr_ft_undergrad,
    sd.enrollmentPartTimeUndergraduate             AS enr_pt_undergrad,
    sd.enrollmentFullTimeGraduate                  AS enr_ft_grad,
    sd.enrollmentPartTimeGraduate                  AS enr_pt_grad,
    sd.enrollmentUndergradInStatePct               AS pct_in_state,
    sd.enrollmentUndergradOutOfStatePct            AS pct_out_of_state,
    sd.enrollmentUndergradOnCampusPct              AS pct_on_campus,
    sd.enrollmentUndergradOffCampusPct             AS pct_off_campus,
    sd.bedsOnCampusReported                        AS beds_on_campus_reported,
    sd.bedsOnCampusComputed                        AS beds_on_campus_computed,
    sd.rateOnCampusRoomYearly                      AS rate_room_yearly,
    sd.rateOnCampusBoardYearly                     AS rate_board_yearly,
    sd.rateOnCampusRoomMonthlyAvg                  AS rate_room_monthly,
    sd.costHousingDelta                            AS cost_housing_delta,
    sd.tuitionInState                              AS tuition_in_state,
    sd.tuitionOutOfState                           AS tuition_out_of_state,
    sd.costPerCreditHourUndergradInState           AS credit_hour_in_state,
    sd.costPerCreditHourUndergradOutOfState        AS credit_hour_out_of_state,
    sd.appliedFirstTimeFirstYear                   AS applied_first_year,
    sd.admittedFirstTimeFirstYear                  AS admitted_first_year,
    sd.admittedFirstTimeFirstYearPct               AS admit_rate,
    sd.enrolledFirstTimeFirstYear                  AS enrolled_first_year,
    sd.appliedTransfer                             AS applied_transfer,
    sd.admittedTransfer                            AS admitted_transfer,
    sd.admittedTransferPct                         AS transfer_admit_rate,
    sd.enrolledTransfer                            AS enrolled_transfer,
    sd.studentAgeAvg                               AS student_age_avg,
    sd.amountParentIncomeAvg                       AS parent_income_avg,
    sd.amountParentIncomeMed                       AS parent_income_med,
    sd.hasDormsCoed                                AS has_dorms_coed,
    sd.hasDormsMen                                 AS has_dorms_men,
    sd.hasDormsWomen                               AS has_dorms_women,
    sd.hasApartmentsMarried                        AS has_apts_married,
    sd.hasApartmentsSingle                         AS has_apts_single,
    sd.hasHousingDisabled                          AS has_housing_disabled,
    sd.hasHousingIntl                              AS has_housing_intl,
    sd.hasHousingGreek                             AS has_housing_greek,
    sd.hasHousingCoop                              AS has_housing_coop
FROM ranked sd
WHERE sd.rn = 1
ORDER BY sd.marketKey, sd.name
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
    parser = argparse.ArgumentParser(description="Refresh university_info from Azure SQL.")
    parser.add_argument("--auth", choices=["aad", "sql", "env"], default="aad")
    args = parser.parse_args()

    cn = connect(args.auth)
    cur = cn.cursor()
    print("Running university_info query ...")
    cur.execute(UNIVERSITY_INFO_SQL)
    cols = [c[0] for c in cur.description]
    rows = [
        {col: _jsonable(val) for col, val in zip(cols, row)}
        for row in cur.fetchall()
    ]
    print(f"fetched {len(rows)} school rows")

    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    payload["tables"]["university_info"] = rows
    DATA_JSON.write_text(
        json.dumps(payload, indent=2, default=str), encoding="utf-8"
    )
    print(f"Wrote {DATA_JSON} ({DATA_JSON.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
