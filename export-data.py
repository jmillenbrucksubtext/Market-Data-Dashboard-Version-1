"""
export-data.py
--------------
Connects to StudentResearch, runs the 9 dashboard queries, and writes a
single data.json that the static site consumes.

Run modes:
  Local — Azure AD interactive (PREFERRED, no password in shell history):
      python export-data.py            # defaults to --auth aad
      python export-data.py --auth aad

  Local — SQL login, prompted via getpass (not echoed, not in argv):
      python export-data.py --auth sql

  CI / scripted — env vars (GitHub Actions cron, see .github/workflows/refresh.yml):
      set SQLUSER=...   set SQLPASSWORD=...
      python export-data.py --auth env

Inputs:
  --auth aad : prompts once for your @subtextliving.com email, then browser sign-in.
  --auth sql : prompts for SQL username + password (getpass, never echoed).
  --auth env : reads SQLUSER + SQLPASSWORD env vars.
  ODBC Driver 18 for SQL Server installed.

Output:
  ./data.json  — one document with metadata + a key per metric table.
"""

from __future__ import annotations

import argparse
import datetime as dt
import decimal
import getpass
import json
import os
import sys
from pathlib import Path

import pyodbc

SERVER = "subtextresearch.database.windows.net"
DATABASE = "StudentResearch"

OUTPUT = Path(__file__).parent / "data.json"

# Same query bodies as the views in d.data-model/metric-views.sql and
# the M expressions in f.powerbi/build-walkthrough.md. Single source of
# truth for the metric definitions.
QUERIES: dict[str, str] = {
    "penetration": """
        SELECT
            m.[Key]                                  AS market_key,
            mr.beds_purpose_built                    AS total_beds,
            mr.enr_total                             AS total_enrollment,
            CASE WHEN mr.enr_total > 0
                 THEN CAST(mr.beds_purpose_built AS DECIMAL(18,6)) / mr.enr_total
                 ELSE NULL END                       AS penetration_ratio,
            CASE
                WHEN mr.enr_total IS NULL OR mr.enr_total = 0 THEN 'N/A'
                WHEN CAST(mr.beds_purpose_built AS DECIMAL(18,6)) / mr.enr_total < 0.30 THEN 'Under-supplied'
                WHEN CAST(mr.beds_purpose_built AS DECIMAL(18,6)) / mr.enr_total > 0.55 THEN 'Over-supplied'
                ELSE 'Balanced'
            END                                      AS market_band,
            mr.snapshot_date                         AS data_as_of
        FROM dbo.Markets m
        JOIN (
            SELECT market_key, MAX(snapshot_date) AS max_snap
            FROM dbo.MarketReports
            WHERE market_key IS NOT NULL
            GROUP BY market_key
        ) latest ON latest.market_key = m.[Key]
        JOIN dbo.MarketReports mr
               ON  mr.market_key    = latest.market_key
               AND mr.snapshot_date = latest.max_snap
    """,
    # prelease_velocity: last 3 cycles only, and only the top 50 markets by
    # tracked-bed volume. The multi-year line chart is unreadable beyond
    # ~30 series anyway; users will filter to a market in the UI.
    "prelease_velocity": """
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
        max_cycle AS (SELECT MAX(leasing_cycle) AS yr FROM cycle_calc),
        top_markets AS (
            SELECT TOP 50 market_key
            FROM cycle_calc, max_cycle
            WHERE leasing_cycle = max_cycle.yr
            GROUP BY market_key
            ORDER BY SUM(beds_tracked_by_prelease) DESC
        )
        SELECT
            cc.market_key,
            cc.leasing_cycle,
            cc.week_of_cycle,
            AVG(CAST(cc.prelease AS DECIMAL(18,6)))  AS prelease_pct,
            SUM(cc.beds_tracked_by_prelease)         AS beds_tracked,
            MAX(cc.snapshot_date)                    AS data_as_of
        FROM cycle_calc cc, max_cycle
        WHERE cc.leasing_cycle >= max_cycle.yr - 2
          AND cc.market_key IN (SELECT market_key FROM top_markets)
        GROUP BY cc.market_key, cc.leasing_cycle, cc.week_of_cycle
    """,
    "existing_beds": """
        SELECT
            m.[Key]                  AS market_key,
            mr.beds_purpose_built    AS existing_beds,
            mr.snapshot_date         AS data_as_of
        FROM dbo.Markets m
        JOIN (
            SELECT market_key, MAX(snapshot_date) AS max_snap
            FROM dbo.MarketReports
            WHERE market_key IS NOT NULL
            GROUP BY market_key
        ) latest ON latest.market_key = m.[Key]
        JOIN dbo.MarketReports mr
               ON  mr.market_key    = latest.market_key
               AND mr.snapshot_date = latest.max_snap
    """,
    "pipeline_beds": """
        SELECT
            m.[Key]                          AS market_key,
            mr.beds_lease_up                 AS beds_lease_up,
            mr.beds_under_construction       AS beds_under_construction,
            mr.beds_planned                  AS beds_planned,
            mr.beds_pipeline                 AS beds_pipeline_total,
            mr.snapshot_date                 AS data_as_of
        FROM dbo.Markets m
        JOIN (
            SELECT market_key, MAX(snapshot_date) AS max_snap
            FROM dbo.MarketReports
            WHERE market_key IS NOT NULL
            GROUP BY market_key
        ) latest ON latest.market_key = m.[Key]
        JOIN dbo.MarketReports mr
               ON  mr.market_key    = latest.market_key
               AND mr.snapshot_date = latest.max_snap
    """,
    # enrollment_total: only schools mapped to a market we're tracking. Drops
    # the ~3,200 schools with no marketKey. Enrollment value/year sourced
    # from the latest Enrollments_Manual row per school (much fresher than
    # the snapshot in Schools_Denormal, which was sometimes ~2014).
    "enrollment_total": """
        SELECT
            sd.schoolKey                                                 AS university_key,
            sd.name                                                      AS university_name,
            sd.marketKey                                                 AS market_key,
            COALESCE(em.Total_Enrollment, sd.enrollmentTotal)            AS total_enrollment,
            sd.enrollmentFullTimeUndergraduate
              + sd.enrollmentPartTimeUndergraduate                       AS total_undergrad,
            COALESCE(em.Year,             sd.enrollmentYear)             AS academic_year
        FROM dbo.Schools_Denormal sd
        JOIN dbo.Markets m ON m.[Key] = sd.marketKey
        LEFT JOIN dbo.IPEDS_CH_Crosswalk cx
               ON cx.[Key]     = sd.schoolKey
              AND cx.marketKey = sd.marketKey
        OUTER APPLY (
            SELECT TOP 1 Total_Enrollment, Year
            FROM dbo.Enrollments_Manual
            WHERE IPEDS_ID = cx.IPEDs
              AND Total_Enrollment > 0
            ORDER BY Year DESC
        ) em
        WHERE COALESCE(em.Total_Enrollment, sd.enrollmentTotal) > 0
    """,
    "enrollment_trend": """
        WITH e AS (
            SELECT em.IPEDS_ID, em.University, em.Year, em.Total_Enrollment
            FROM dbo.Enrollments_Manual em
            WHERE em.Total_Enrollment > 0
        ),
        latest AS (SELECT IPEDS_ID, MAX(Year) AS yr_max FROM e GROUP BY IPEDS_ID)
        SELECT
            cur.IPEDS_ID                                AS ipeds_id,
            cur.University                              AS university_name,
            cx.marketKey                                AS market_key,
            cur.Year                                    AS current_year,
            cur.Total_Enrollment                        AS current_enrollment,
            prev1.Total_Enrollment                      AS prev_year_enrollment,
            CASE WHEN prev1.Total_Enrollment > 0
                 THEN CAST(cur.Total_Enrollment AS DECIMAL(18,6)) / prev1.Total_Enrollment - 1
                 ELSE NULL END                          AS yoy_change,
            CASE WHEN prev5.Total_Enrollment > 0
                 THEN POWER(CAST(cur.Total_Enrollment AS DECIMAL(18,8)) / prev5.Total_Enrollment, 1.0/5.0) - 1
                 ELSE NULL END                          AS cagr_5yr
        FROM e cur
        JOIN latest l            ON l.IPEDS_ID = cur.IPEDS_ID AND l.yr_max = cur.Year
        LEFT JOIN e prev1        ON prev1.IPEDS_ID = cur.IPEDS_ID AND prev1.Year = cur.Year - 1
        LEFT JOIN e prev5        ON prev5.IPEDS_ID = cur.IPEDS_ID AND prev5.Year = cur.Year - 5
        LEFT JOIN dbo.IPEDS_CH_Crosswalk cx ON cx.IPEDs = cur.IPEDS_ID
        LEFT JOIN dbo.Markets            m  ON m.[Key]  = cx.marketKey
    """,
    # fte_history: per-market full-time enrollment at three points in time —
    # current snapshot, ~1 year prior, and a 2021-22 academic-year baseline.
    # Drives the FTE YoY KPI tile and the two FTE qualifiers
    # ("FTE growth YoY positive", "FTE growth since 2022 above 3%").
    "fte_history": """
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
        prior_yr AS (
            SELECT
                cs.market_key,
                mr.snapshot_date         AS prior_yr_date,
                mr.enr_full_time         AS prior_yr_fte,
                ROW_NUMBER() OVER (
                    PARTITION BY cs.market_key
                    ORDER BY ABS(DATEDIFF(DAY, DATEADD(YEAR, -1, cs.current_date_), mr.snapshot_date))
                ) AS rn
            FROM current_snap cs
            JOIN dbo.MarketReports mr
                   ON  mr.market_key     = cs.market_key
                  AND mr.enr_full_time  IS NOT NULL
                  AND mr.snapshot_date BETWEEN DATEADD(DAY, -540, cs.current_date_)
                                           AND DATEADD(DAY, -180, cs.current_date_)
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
    """,
    "avg_rent": """
        SELECT
            m.[Key]                          AS market_key,
            mr.rate_avg                      AS avg_rent_per_bed,
            mr.beds_tracked_by_occupancy     AS bed_weight,
            mr.snapshot_date                 AS data_as_of
        FROM dbo.Markets m
        JOIN (
            SELECT market_key, MAX(snapshot_date) AS max_snap
            FROM dbo.MarketReports
            WHERE market_key IS NOT NULL
            GROUP BY market_key
        ) latest ON latest.market_key = m.[Key]
        JOIN dbo.MarketReports mr
               ON  mr.market_key    = latest.market_key
               AND mr.snapshot_date = latest.max_snap
        WHERE mr.rate_avg IS NOT NULL
    """,
    "rent_yoy": """
        WITH current_snap AS (
            SELECT
                latest.market_key,
                latest.max_snap AS current_date_,
                mr.rate_avg     AS current_avg_rent
            FROM (
                SELECT market_key, MAX(snapshot_date) AS max_snap
                FROM dbo.MarketReports
                WHERE market_key IS NOT NULL AND rate_avg IS NOT NULL
                GROUP BY market_key
            ) latest
            JOIN dbo.MarketReports mr
                   ON  mr.market_key    = latest.market_key
                   AND mr.snapshot_date = latest.max_snap
        ),
        prior AS (
            SELECT
                cs.market_key,
                cs.current_date_,
                cs.current_avg_rent,
                prior_mr.snapshot_date AS prior_date_,
                prior_mr.rate_avg      AS prior_avg_rent,
                ROW_NUMBER() OVER (
                    PARTITION BY cs.market_key
                    ORDER BY ABS(DATEDIFF(DAY, DATEADD(YEAR, -1, cs.current_date_), prior_mr.snapshot_date))
                ) AS rn
            FROM current_snap cs
            JOIN dbo.MarketReports prior_mr
                   ON  prior_mr.market_key = cs.market_key
                  AND prior_mr.rate_avg   IS NOT NULL
                  AND prior_mr.snapshot_date BETWEEN DATEADD(DAY, -395, cs.current_date_)
                                                 AND DATEADD(DAY, -335, cs.current_date_)
        )
        SELECT
            p.market_key,
            p.current_date_           AS current_snapshot,
            p.prior_date_             AS prior_snapshot,
            p.current_avg_rent,
            p.prior_avg_rent,
            CASE WHEN p.prior_avg_rent > 0
                 THEN CAST(p.current_avg_rent AS DECIMAL(18,6)) / p.prior_avg_rent - 1
                 ELSE NULL END        AS yoy_rent_growth,
            p.current_date_           AS data_as_of
        FROM prior p
        JOIN dbo.Markets m ON m.[Key] = p.market_key
        WHERE p.rn = 1
    """,
    # properties: every purpose-built property mapped to a market. Drives the
    # property list and the map on market.html. Drop isShadow=1 (shadow market)
    # and rows without lat/long since the map can't render them.
    "properties": """
        WITH plan_latest AS (
            -- Latest snapshot per property in PlanReports
            SELECT property_key, MAX(snapshot_date) AS max_snap
            FROM dbo.PlanReports
            WHERE property_key IS NOT NULL AND prelease IS NOT NULL
            GROUP BY property_key
        ),
        plan_agg AS (
            -- Bed-weighted prelease from plan-level data at the latest snapshot.
            -- PlanReports.prelease coverage is ~6.6M rows vs Properties.prelease
            -- which is null for ~99.7% of rows — this is the actual source.
            SELECT
                pr.property_key,
                SUM(CAST(pr.prelease AS DECIMAL(18,6)) * pr.beds_purpose_built)
                    / NULLIF(SUM(pr.beds_purpose_built), 0) AS weighted_prelease,
                MAX(pr.snapshot_date) AS prelease_as_of
            FROM dbo.PlanReports pr
            JOIN plan_latest pl
                   ON  pl.property_key = pr.property_key
                  AND pl.max_snap      = pr.snapshot_date
            WHERE pr.prelease IS NOT NULL
              AND pr.beds_purpose_built > 0
            GROUP BY pr.property_key
        )
        SELECT
            p.[Key]                                 AS property_key,
            p.marketKey                             AS market_key,
            p.name                                  AS property_name,
            p.type                                  AS property_type,
            p.phase                                 AS phase,
            p.street1,
            p.city,
            p.state,
            p.latitude,
            p.longitude,
            p.bedsPurposeBuilt                      AS beds,
            p.units,
            p.yearBuilt,
            p.occupancy,
            COALESCE(p.prelease, pa.weighted_prelease) AS prelease,
            pa.prelease_as_of                       AS prelease_as_of,
            p.rateAvg                               AS avg_rent,
            p.ratePerSfAvg                          AS avg_rent_per_sf,
            p.concessionsValue,
            p.hasConcessions,
            p.milesToClosestCampus,
            p.currentGoogleReviewAvg,
            p.currentGoogleReviews                  AS google_review_count,
            CAST(p.lastReportDate AS DATETIME2)     AS last_report_date
        FROM dbo.Properties p
        LEFT JOIN plan_agg pa ON pa.property_key = p.[Key]
        WHERE p.marketKey IS NOT NULL
          AND COALESCE(p.isShadow, 0) = 0
    """,
    # plans: every floor plan tied to a purpose-built property we already
    # track. Drives the property.html floor-plan table.
    "plans": """
        SELECT
            pl.[Key]                     AS plan_key,
            pl.propertyKey               AS property_key,
            pl.marketKey                 AS market_key,
            pl.name                      AS plan_name,
            pl.unitTypeName              AS unit_type_name,
            pl.format,
            pl.isStudio                  AS is_studio,
            pl.bedrooms,
            pl.bathrooms,
            pl.areaSf                    AS area_sf,
            pl.bedsPurposeBuilt          AS beds_in_plan,
            pl.occupancy,
            pl.prelease,
            pl.rate,
            pl.ratePerSf                 AS rate_per_sf,
            pl.hasConcessions            AS has_concessions,
            pl.concessionsValue          AS concessions_value,
            pl.concessionsNotes          AS concessions_notes,
            CAST(pl.reportDate AS DATETIME2) AS report_date
        FROM dbo.Plans pl
        JOIN dbo.Properties p ON p.[Key] = pl.propertyKey
        WHERE p.marketKey IS NOT NULL
          AND COALESCE(p.isShadow, 0) = 0
    """,
    # campus_locations: every school with lat/long that maps to a market we
    # track. The market_detail page uses these to drop campus pins on the map.
    # Enrollment value/year now comes from the latest Enrollments_Manual row
    # per school (typically 2023–2024), falling back to Schools_Denormal's
    # stale snapshot only when no IPEDS history exists.
    "campus_locations": """
        SELECT
            sd.marketKey                                            AS market_key,
            sd.schoolKey                                            AS school_key,
            cx.IPEDs                                                AS ipeds_id,
            sd.name                                                 AS university_name,
            sd.latitude                                             AS campus_lat,
            sd.longitude                                            AS campus_lng,
            COALESCE(em.Total_Enrollment, sd.enrollmentTotal)       AS total_enrollment,
            COALESCE(em.Year,             sd.enrollmentYear)        AS enrollment_year
        FROM dbo.Schools_Denormal sd
        JOIN dbo.Markets m ON m.[Key] = sd.marketKey
        LEFT JOIN dbo.IPEDS_CH_Crosswalk cx
               ON cx.[Key]     = sd.schoolKey
              AND cx.marketKey = sd.marketKey
        OUTER APPLY (
            SELECT TOP 1 Total_Enrollment, Year
            FROM dbo.Enrollments_Manual
            WHERE IPEDS_ID = cx.IPEDs
              AND Total_Enrollment > 0
            ORDER BY Year DESC
        ) em
        WHERE sd.latitude  IS NOT NULL
          AND sd.longitude IS NOT NULL
    """,
    # scorecard is the master per-market table. anchor_university = largest
    # university by enrollment in that market (fallback "City, ST" if no school
    # is mapped). is_subtext30 = 1 if any university in this market is one of
    # the Subtext 30 focus universities.
    "scorecard": """
        WITH latest AS (
            SELECT market_key, MAX(snapshot_date) AS max_snap
            FROM dbo.MarketReports
            WHERE market_key IS NOT NULL
            GROUP BY market_key
        ),
        anchor AS (
            SELECT m.[Key] AS market_key, a.name AS anchor_university
            FROM dbo.Markets m
            OUTER APPLY (
                SELECT TOP 1 sd.name
                FROM dbo.Schools_Denormal sd
                WHERE sd.marketKey = m.[Key] AND sd.enrollmentTotal > 0
                ORDER BY sd.enrollmentTotal DESC, sd.name
            ) a
        ),
        s30 AS (
            SELECT DISTINCT cx.marketKey AS market_key
            FROM dbo.Subtext30 s
            JOIN dbo.IPEDS_CH_Crosswalk cx ON cx.IPEDs = s.IPEDS_ID
            WHERE cx.marketKey IS NOT NULL
        )
        SELECT
            m.[Key]                                              AS market_key,
            COALESCE(a.anchor_university,
                     m.city + ', ' + m.stateAbbr)                AS anchor_university,
            m.city                                               AS city,
            m.stateAbbr                                          AS state_abbr,
            m.region                                             AS region,   -- regional grouping (Midwest, South, ...)
            CASE WHEN s30.market_key IS NOT NULL THEN 1 ELSE 0 END
                                                                 AS is_subtext30,
            CASE WHEN mr.enr_total > 0
                 THEN CAST(mr.beds_purpose_built AS DECIMAL(18,6)) / mr.enr_total END
                                                                 AS penetration_ratio,
            mr.beds_purpose_built                                AS existing_beds,
            mr.beds_lease_up,
            mr.beds_under_construction,
            mr.beds_planned,
            mr.beds_pipeline                                     AS beds_pipeline_total,
            mr.enr_total                                         AS total_enrollment,
            mr.enr_full_time                                     AS enr_full_time,
            mr.rate_avg                                          AS avg_rent_per_bed,
            mr.occupancy                                         AS occupancy,
            mr.prelease                                          AS prelease,
            mr.snapshot_date                                     AS data_as_of
        FROM dbo.Markets m
        JOIN latest               ON latest.market_key = m.[Key]
        JOIN dbo.MarketReports mr ON mr.market_key = latest.market_key
                                  AND mr.snapshot_date = latest.max_snap
        LEFT JOIN anchor a        ON a.market_key   = m.[Key]
        LEFT JOIN s30             ON s30.market_key = m.[Key]
    """,
    # market_history: one anchor snapshot per (market, year) from 2020+.
    # Each year is anchored to the SAME calendar date as the latest
    # available snapshot, so the year-over-year comparison is apples to
    # apples (e.g., 2026-05-09 vs 2025-05-09 vs 2024-05-09 ...). This
    # moves automatically as the weekly refresh advances the latest
    # snapshot. Feeds the deck-style multi-year charts on market.html.
    "market_history": (
        "WITH la AS (SELECT MONTH(MAX(snapshot_date)) AS mo, DAY(MAX(snapshot_date)) AS dy FROM dbo.MarketReports), "
        "a AS ("
        "SELECT mr.market_key, YEAR(mr.snapshot_date) AS yr, mr.snapshot_date, mr.rate_avg, mr.occupancy, mr.prelease, "
        "mr.beds_purpose_built, mr.beds_lease_up, mr.beds_under_construction, mr.beds_planned, mr.beds_pipeline, "
        "ROW_NUMBER() OVER (PARTITION BY mr.market_key, YEAR(mr.snapshot_date) "
        "ORDER BY ABS(DATEDIFF(DAY, mr.snapshot_date, "
        "DATEFROMPARTS(YEAR(mr.snapshot_date), la.mo, "
        "CASE WHEN la.dy > DAY(EOMONTH(DATEFROMPARTS(YEAR(mr.snapshot_date), la.mo, 1))) "
        "THEN DAY(EOMONTH(DATEFROMPARTS(YEAR(mr.snapshot_date), la.mo, 1))) ELSE la.dy END)))) AS rn "
        "FROM dbo.MarketReports mr CROSS JOIN la "
        "WHERE mr.market_key IS NOT NULL AND YEAR(mr.snapshot_date) >= 2020"
        ") "
        "SELECT market_key, yr AS year_, snapshot_date AS data_as_of, rate_avg AS avg_rent_per_bed, "
        "occupancy, prelease, beds_purpose_built AS existing_beds, beds_lease_up, beds_under_construction, "
        "beds_planned, beds_pipeline AS beds_pipeline_total "
        "FROM a WHERE rn = 1 ORDER BY market_key, yr"
    ),
}


def to_jsonable(value):
    """Convert pyodbc row values to JSON-serializable primitives."""
    if value is None:
        return None
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    return value


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
        # Entra-joined boxes; the script can run unattended.
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
            sys.exit("--auth env requires SQLUSER and SQLPASSWORD env vars to be set.")
        cs = base + f"UID={uid};PWD={pwd};"
    else:
        sys.exit(f"Unknown --auth mode: {auth}")
    return pyodbc.connect(cs, timeout=30)


EXCEL_PATH = Path(
    r"C:\Users\JakeMillenbruck\Subtext\Subtext - Documents"
    r"\General\Markets\Support\Market Analysis Schedule.xlsx"
)

# Map the Schedule sheet's row-2 headers to clean JSON keys.
# Two columns share the label "Decision" — we disambiguate by position.
SCHEDULE_COLUMNS = {
    2: "market_type",            # col B
    3: "market_name",            # col C ("New Market Review")
    4: "analyst",                # col D ("Analyst/Intern")
    5: "initial_analysis_date",  # col E
    8: "initial_decision",       # col H ("Decision" #1)
    9: "ic_date",                # col I
    10: "ic_decision",           # col J ("Decision" #2)
    11: "status",                # col K
    12: "est_sites",             # col L
    13: "notes",                 # col M
}


def read_market_analysis_excel() -> list[dict]:
    """Read the Market Analysis Schedule sheet into a list of row dicts.

    Column A on the sheet contains section headers (e.g., 'Deferred and Assessing
    Markets', 'Approved Markets'). Data rows follow each section header with
    column A blank. We attach the most-recent section header as `category` on
    every data row that follows.

    Missing file is non-fatal — returns []."""
    if not EXCEL_PATH.exists():
        print(f"  Excel not found at {EXCEL_PATH} (skipping)")
        return []
    try:
        import openpyxl  # local import — only needed if file is present
    except ImportError:
        print("  openpyxl not installed (skipping Excel)")
        return []

    wb = openpyxl.load_workbook(EXCEL_PATH, data_only=True, read_only=True)
    if "Market Analysis Schedule" not in wb.sheetnames:
        print("  'Market Analysis Schedule' sheet missing (skipping)")
        return []
    ws = wb["Market Analysis Schedule"]

    rows_out: list[dict] = []
    current_category: str | None = None

    for row_idx, row in enumerate(ws.iter_rows(values_only=True), 1):
        if row_idx <= 2:
            continue  # skip blank row 1 and header row 2

        col_a = row[0]
        data_cols = [row[idx - 1] for idx in SCHEDULE_COLUMNS]

        # Section header: col A populated, other tracked cols empty
        if col_a and not any(v not in (None, "") for v in data_cols):
            current_category = str(col_a).strip()
            continue

        # Skip rows that are entirely empty across tracked cols
        if not any(v not in (None, "") for v in data_cols):
            continue

        # Skip per-section header rows that repeat the column labels.
        # These show up at the start of each section in the sheet with values
        # like market_type='Market Type', market_name='Market', etc.
        mt = (row[1] or "").strip() if isinstance(row[1], str) else row[1]
        if mt in ("Market Type",):
            continue

        row_dict: dict = {"category": current_category}
        for col_idx, key in SCHEDULE_COLUMNS.items():
            v = row[col_idx - 1]
            if isinstance(v, dt.datetime):
                row_dict[key] = v.date().isoformat()
            elif isinstance(v, dt.date):
                row_dict[key] = v.isoformat()
            elif v is None:
                row_dict[key] = None
            else:
                row_dict[key] = str(v).strip() if isinstance(v, str) else v
        rows_out.append(row_dict)

    print(f"  market_analysis_schedule  {len(rows_out)} rows  ({EXCEL_PATH.name})")
    return rows_out


# ============================================================
# Subtext Qualifier Engine
# ------------------------------------------------------------
# Criteria come from the "Market Analysis Qualifiers" sheet of
# Market Analysis Schedule.xlsx. Each evaluator computes a market's
# actual value and compares to the threshold. Returns:
#   {"id", "label", "threshold_display", "actual_display", "actual",
#    "status": "pass" | "fail" | "na", "explanation"}
# Phase-2 evaluators return status="na" until we wire their data source.
# ============================================================

def _na(qid, label, threshold_display, reason="Phase 2 — data not yet loaded"):
    return {
        "id": qid, "label": label,
        "threshold_display": threshold_display,
        "actual_display": "—", "actual": None,
        "status": "na", "tier": "na", "explanation": reason,
    }


def _tier(actual, threshold, margin, direction):
    """Return one of: 'pass' | 'warn' | 'fail' based on how far the actual
    value is from the threshold. `margin` defines the borderline window.
    direction: 'above' (pass if actual > threshold) or 'below' (pass if ≤)."""
    if direction == "above":
        if actual > threshold + margin: return "pass"
        if actual < threshold - margin: return "fail"
        return "warn"
    if direction == "below":
        if actual <= threshold - margin: return "pass"
        if actual > threshold + margin: return "fail"
        return "warn"
    return "warn"


def _result(qid, label, threshold_display, actual, actual_display,
            threshold, margin, direction, explanation):
    """Compute pass/fail status AND a pass/warn/fail tier for visual coloring."""
    if direction == "above":
        passed = actual > threshold
    else:  # "below"
        passed = actual <= threshold
    tier = _tier(actual, threshold, margin, direction)
    return {
        "id": qid, "label": label,
        "threshold_display": threshold_display,
        "actual_display": actual_display, "actual": actual,
        "status": "pass" if passed else "fail",
        "tier": tier,
        "explanation": explanation,
    }


def _q_rent_market(market, _props_by_market):
    rent = market.get("avg_rent_per_bed")
    if rent is None:
        return _na("rent_market", "Nominal market rent above $900", "> $900",
                   "no market rent on file")
    rent = float(rent)
    return _result(
        "rent_market", "Nominal market rent above $900", "> $900",
        actual=rent, actual_display=f"${rent:,.0f}",
        threshold=900, margin=90, direction="above",
        explanation="from MarketReports.rate_avg",
    )


def _q_rent_compset(market, props_by_market):
    mk = market["market_key"]
    rents = [p["avg_rent"] for p in props_by_market.get(mk, []) if p.get("avg_rent")]
    if not rents:
        return _na("rent_compset", "Comp-set rent above $1,000", "> $1,000",
                   "no comp properties with rent")
    avg = sum(rents) / len(rents)
    return _result(
        "rent_compset", "Comp-set rent above $1,000", "> $1,000",
        actual=avg, actual_display=f"${avg:,.0f}",
        threshold=1000, margin=100, direction="above",
        explanation=f"average across {len(rents)} comp properties",
    )


def _q_fte(market, _props_by_market):
    fte = market.get("enr_full_time")
    if fte is None:
        return _na("fte", "FTE enrollment above 15,000", "> 15,000",
                   "no FTE on file")
    return _result(
        "fte", "FTE enrollment above 15,000", "> 15,000",
        actual=fte, actual_display=f"{int(fte):,}",
        threshold=15000, margin=1500, direction="above",
        explanation="from MarketReports.enr_full_time",
    )


def _q_occupancy(market, _props_by_market):
    occ = market.get("occupancy")
    if occ is None:
        return _na("occupancy", "Market occupancy above 90%", "> 90%",
                   "no occupancy on file")
    occ = float(occ)
    return _result(
        "occupancy", "Market occupancy above 90%", "> 90%",
        actual=occ, actual_display=f"{occ * 100:.1f}%",
        threshold=0.90, margin=0.02, direction="above",
        explanation="from MarketReports.occupancy",
    )


def _q_pipeline(market, _props_by_market):
    pipe = market.get("beds_pipeline_total")
    existing = market.get("existing_beds")
    if not existing or pipe is None:
        return _na("pipeline", "Pipeline ≤ 10% of existing supply", "≤ 10% of existing",
                   "no supply data on file")
    ratio = pipe / existing
    return _result(
        "pipeline", "Pipeline ≤ 10% of existing supply", "≤ 10% of existing",
        actual=ratio, actual_display=f"{ratio * 100:.1f}%",
        threshold=0.10, margin=0.02, direction="below",
        explanation=f"{pipe:,} pipeline / {existing:,} existing PBSH beds",
    )


# --- Phase 2 placeholders (need additional data pulls) -----------------

def _q_fte_growth_2022(market, _props_by_market):
    fte_hist = market.get("fte_history")
    if not fte_hist or fte_hist.get("fte_growth_since_2022") is None:
        return _na("fte_growth_2022", "FTE growth since 2022 above 3%", "≥ 3% since 2022",
                   "no 2021-22 FTE baseline")
    g = float(fte_hist["fte_growth_since_2022"])
    sign = "+" if g >= 0 else ""
    baseline_yr = (fte_hist.get("baseline_2022_snapshot") or "")[:4]
    return _result(
        "fte_growth_2022", "FTE growth since 2022 above 3%", "≥ 3% since 2022",
        actual=g, actual_display=f"{sign}{g * 100:.1f}%",
        threshold=0.03, margin=0.005, direction="above",
        explanation=(
            f"current FTE {int(fte_hist['current_fte']):,} vs "
            f"{int(fte_hist['baseline_2022_fte']):,} ({baseline_yr})"
        ),
    )


def _q_fte_growth_yoy(market, _props_by_market):
    fte_hist = market.get("fte_history")
    if not fte_hist or fte_hist.get("yoy_fte_growth") is None:
        return _na("fte_growth_yoy", "FTE growth YoY positive", "> 0% YoY",
                   "no prior-year FTE snapshot")
    yoy = float(fte_hist["yoy_fte_growth"])
    sign = "+" if yoy >= 0 else ""
    return _result(
        "fte_growth_yoy", "FTE growth YoY positive", "> 0% YoY",
        actual=yoy, actual_display=f"{sign}{yoy * 100:.1f}%",
        threshold=0.0, margin=0.005, direction="above",
        explanation=(
            f"current FTE {int(fte_hist['current_fte']):,} vs "
            f"{int(fte_hist['prior_year_fte']):,} a year ago"
        ),
    )

def _q_rent_growth_3yr(_m, _p):
    return _na("rent_growth_3yr", "YoY rent growth ≥3% for trailing 3 years", "≥ 3% for 3 trailing years")

def _q_prelease_vs_prior(market, _props_by_market):
    yoy = market.get("prelease_yoy")
    if not yoy:
        return _na("prelease_lag", "Market prelease not lagging prior year by >5%", "delta ≥ −5%",
                   "no same-week prior-cycle observation")
    delta = yoy["delta"]
    sign = "+" if delta >= 0 else ""
    cur_pct = yoy["current_prelease"] * 100
    prior_pct = yoy["prior_prelease"] * 100
    return _result(
        "prelease_lag", "Market prelease not lagging prior year by >5%", "delta ≥ −5%",
        actual=delta, actual_display=f"{sign}{delta * 100:.1f} pp",
        threshold=-0.05, margin=0.01, direction="above",
        explanation=(
            f"week {yoy['current_week']} of cycle {yoy['current_cycle']}: "
            f"{cur_pct:.1f}% vs {prior_pct:.1f}% same week in "
            f"cycle {yoy['current_cycle'] - 1}"
        ),
    )

def _q_uncaptured_demand(_m, _p):
    return _na("uncaptured_1mi", "Uncaptured demand within 1 mile above 30%", "> 30%")

def _q_income(market, _props_by_market):
    inc = market.get("mean_origin_income")
    n = market.get("affluence_n_students")
    if inc is None or (n is not None and n < 100):
        return _na("income_median_zips", "Avg income of median zipcodes above $85K", "> $85,000",
                   "no migration sample" if inc is None else f"sample too small (n={n})")
    return _result(
        "income_median_zips", "Avg income of median zipcodes above $85K", "> $85,000",
        actual=inc, actual_display=f"${inc:,.0f}",
        threshold=85000, margin=5000, direction="above",
        explanation=(
            f"mean origin household income across {int(n):,} students "
            "(migration data, 2023-07 + 2023-08)"
        ) if n is not None else "mean origin household income (migration data)",
    )


# Display order matches the Excel sheet.
QUALIFIER_EVALUATORS = [
    _q_rent_market,
    _q_rent_compset,
    _q_fte,
    _q_occupancy,
    _q_fte_growth_2022,
    _q_fte_growth_yoy,
    _q_rent_growth_3yr,
    _q_prelease_vs_prior,
    _q_pipeline,
    _q_uncaptured_demand,
    _q_income,
]


def compute_qualifiers(tables: dict) -> list[dict]:
    """Return list of {market_key, results, passes, evaluable, total, score_pct}."""
    sc = tables.get("scorecard", [])
    props = tables.get("properties", [])

    by_market: dict = {}
    for p in props:
        by_market.setdefault(p["market_key"], []).append(p)

    # Affluence is computed earlier in main(); merge those fields into each
    # market dict so income-driven evaluators can read them.
    affluence_by_market = {
        a["market_key"]: a for a in tables.get("market_affluence", [])
    }
    # Prelease YoY is derived from the prelease_velocity table.
    from load_affluence import compute_prelease_yoy
    prelease_yoy_by_market = compute_prelease_yoy(tables.get("prelease_velocity", []))

    # FTE history from the new fte_history query.
    fte_history_by_market = {
        r["market_key"]: r for r in tables.get("fte_history", [])
    }

    out: list[dict] = []
    for market in sc:
        m = dict(market)
        a = affluence_by_market.get(m["market_key"])
        if a is not None:
            m["mean_origin_income"] = a.get("mean_origin_income")
            m["affluence_n_students"] = a.get("n_students")
        m["prelease_yoy"] = prelease_yoy_by_market.get(m["market_key"])
        m["fte_history"] = fte_history_by_market.get(m["market_key"])
        results = [ev(m, by_market) for ev in QUALIFIER_EVALUATORS]
        evaluable = [r for r in results if r["status"] != "na"]
        passes = sum(1 for r in evaluable if r["status"] == "pass")
        out.append({
            "market_key": m["market_key"],
            "results": results,
            "passes": passes,
            "evaluable": len(evaluable),
            "total": len(results),
            "score_pct": (passes / len(evaluable)) if evaluable else None,
        })
    placeholders = sum(1 for r in out[0]["results"] if r["status"] == "na") if out else 0
    print(f"  market_qualifiers computed for {len(out)} markets "
          f"({len(QUALIFIER_EVALUATORS) - placeholders} live, {placeholders} placeholders)")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Export Azure SQL data to data.json.")
    parser.add_argument(
        "--auth",
        choices=["aad", "integrated", "sql", "env"],
        default="aad",
        help="Auth mode (default: aad — Azure AD interactive). "
             "'integrated' uses Windows AAD silently; "
             "'sql' prompts via getpass; 'env' reads SQLUSER/SQLPASSWORD.",
    )
    args = parser.parse_args()

    cn = connect(args.auth)
    cur = cn.cursor()

    payload: dict = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": f"{DATABASE} @ {SERVER}",
        "tables": {},
    }

    for name, sql in QUERIES.items():
        print(f"  {name} ...", end="", flush=True)
        cur.execute(sql)
        cols = [c[0] for c in cur.description]
        rows = [
            {col: to_jsonable(val) for col, val in zip(cols, row)}
            for row in cur.fetchall()
        ]
        payload["tables"][name] = rows
        print(f" {len(rows)} rows")

    # --- Read the Market Analysis Schedule Excel (OneDrive synced file) ---
    payload["tables"]["market_analysis_schedule"] = read_market_analysis_excel()

    # --- Compute per-market affluence from migration CSV ---
    # Source: ../Affluence Data/MigrationAllRents*.csv (newest file).
    # Logic lives in load_affluence.py so it can also run standalone
    # without an Azure SQL refresh. Must run BEFORE compute_qualifiers so
    # the income qualifier can read mean_origin_income.
    from load_affluence import (
        build_market_affluence, newest_csv, DEFAULT_CSV_DIR, DEFAULT_MONTHS,
    )
    try:
        aff_csv = newest_csv(DEFAULT_CSV_DIR)
        ipeds_to_market = {
            int(r["ipeds_id"]): int(r["market_key"])
            for r in payload["tables"].get("campus_locations", [])
            if r.get("ipeds_id") is not None and r.get("market_key") is not None
        }
        payload["tables"]["market_affluence"] = build_market_affluence(
            aff_csv, ipeds_to_market, months=list(DEFAULT_MONTHS),
        )
        print(f"  market_affluence from {aff_csv.name} "
              f"[months={','.join(DEFAULT_MONTHS)}]: "
              f"{len(payload['tables']['market_affluence'])} markets")
    except SystemExit as e:
        print(f"  market_affluence SKIPPED: {e}")
        payload["tables"]["market_affluence"] = []

    # --- Compute Subtext qualifier scorecard per market ---
    payload["tables"]["market_qualifiers"] = compute_qualifiers(payload["tables"])

    # --- Fetch this week's Subtext Dispatch headlines (for the ticker) ---
    # Lives at the top level (not under 'tables') because it's a single
    # object, not a row-set. Non-fatal: dispatch outages must not block
    # the weekly SQL refresh.
    try:
        from load_dispatch import fetch_dispatch_headlines
        payload["dispatch_headlines"] = fetch_dispatch_headlines()
        print(f"  dispatch_headlines: "
              f"{len(payload['dispatch_headlines']['features'])} features + "
              f"{len(payload['dispatch_headlines']['briefs'])} briefs "
              f"[{payload['dispatch_headlines']['issue']}]")
    except Exception as e:
        print(f"  dispatch_headlines SKIPPED: {type(e).__name__}: {e}")
        payload["dispatch_headlines"] = None

    # --- Split: plans → per-property JSON files (loaded on demand) ---
    plans_dir = OUTPUT.parent / "plans"
    plans_dir.mkdir(exist_ok=True)
    plans = payload["tables"].pop("plans", [])
    by_property: dict[int, list[dict]] = {}
    for row in plans:
        pk = row.get("property_key")
        if pk is None:
            continue
        by_property.setdefault(pk, []).append(row)
    # Clean stale files before writing the new set
    for old in plans_dir.glob("*.json"):
        old.unlink()
    for pk, rows in by_property.items():
        (plans_dir / f"{pk}.json").write_text(
            json.dumps(rows, default=str), encoding="utf-8",
        )
    print(f"  plans split into {len(by_property)} per-property files in {plans_dir}/")

    # Derived dashboard-level data_as_of = min across all tables that carry one
    as_ofs = []
    for table in payload["tables"].values():
        for row in table:
            for k, v in row.items():
                if k in ("data_as_of", "current_snapshot") and v:
                    as_ofs.append(v)
    payload["data_as_of"] = max(as_ofs) if as_ofs else None

    with OUTPUT.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, default=str)

    size_kb = OUTPUT.stat().st_size / 1024
    print(f"\nWrote {OUTPUT} ({size_kb:.0f} KB)")
    print(f"data_as_of = {payload['data_as_of']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
