"""
Build the historical admissions repository from IPEDS.

The "Applications, Acceptance & Yield" chart on the University tab needs a
multi-year admissions funnel (applications -> admitted -> enrolled) per school.
The Common Data Set publishes this (Section C1), but every school posts its own
PDF at a non-standard URL - not bulk-downloadable. IPEDS collects the same
figures in its annual ADM (Admissions) survey, published as one standardized
CSV per year keyed by UNITID (= the ipeds_id this project already uses for
enrollment history). So we pull IPEDS instead of scraping CDS PDFs.

This script:
  1. reads the set of ipeds_ids the dashboard tracks (from data.json),
  2. downloads each ADM<year>.zip from the IPEDS data center (cached locally),
  3. extracts APPLCN (applications), ADMSSN (admitted), ENRLT (enrolled) for
     our schools,
  4. writes "Admissions Data/admissions_history.xlsx" - the editable repository.

load_admissions_history.py then reads that workbook into data.json.

Years: 2018 through the latest ADM file IPEDS has published (currently 2023;
IPEDS lags ~1.5 years, so re-run this when newer files land).

Run:
    python build_admissions_repository.py
"""

from __future__ import annotations

import csv
import io
import json
import urllib.request
import zipfile
from pathlib import Path

from openpyxl import Workbook

HERE = Path(__file__).resolve().parent
DATA_JSON = HERE / "data.json"
OUT_DIR = HERE / "Admissions Data"
OUT_XLSX = OUT_DIR / "admissions_history.xlsx"
CACHE = HERE / "_ipeds_cache"          # local zip cache (git-ignored)
IPEDS_URL = "https://nces.ed.gov/ipeds/datacenter/data/ADM{year}.zip"
START_YEAR = 2018
END_YEAR = 2030                        # probe upward; stop at first missing file


def tracked_schools() -> dict[int, str]:
    """ipeds_id -> university_name for every school the dashboard tracks."""
    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    names: dict[int, str] = {}
    for table in ("enrollment_history", "campus_locations", "university_info"):
        for r in payload["tables"].get(table, []):
            ip = r.get("ipeds_id")
            if ip in (None, 0):
                continue
            names.setdefault(int(ip), r.get("university_name") or r.get("short_name") or "")
    return names


def adm_rows_for_year(year: int, ids: set[int]) -> dict[int, dict]:
    """Download (or read cached) ADM<year>.zip and pull the funnel for our ids.
    Returns {} when IPEDS has no file for that year yet."""
    CACHE.mkdir(exist_ok=True)
    zpath = CACHE / f"ADM{year}.zip"
    if not zpath.exists():
        url = IPEDS_URL.format(year=year)
        try:
            data = urllib.request.urlopen(url, timeout=120).read()
        except Exception:
            return {}
        zpath.write_bytes(data)
    try:
        z = zipfile.ZipFile(zpath)
    except zipfile.BadZipFile:
        zpath.unlink(missing_ok=True)
        return {}
    # Prefer the revised (_rv) file when present - IPEDS' final cleaned data.
    members = [n for n in z.namelist() if n.lower().endswith(".csv")]
    name = next((n for n in members if "_rv" in n.lower()), members[0])
    reader = csv.DictReader(z.read(name).decode("latin-1").splitlines())

    def num(v):
        v = (v or "").strip()
        try:
            return int(float(v))
        except (ValueError, TypeError):
            return None

    out: dict[int, dict] = {}
    for row in reader:
        try:
            uid = int(row["UNITID"])
        except (ValueError, KeyError, TypeError):
            continue
        if uid not in ids:
            continue
        appl, adm, enr = num(row.get("APPLCN")), num(row.get("ADMSSN")), num(row.get("ENRLT"))
        if appl is None and adm is None and enr is None:
            continue
        out[uid] = {"applications": appl, "admitted": adm, "enrolled": enr}
    return out


def main() -> int:
    names = tracked_schools()
    ids = set(names)
    print(f"{len(ids)} tracked ipeds_ids")

    # Collect available years until IPEDS has no file.
    by_year: dict[int, dict[int, dict]] = {}
    for year in range(START_YEAR, END_YEAR + 1):
        rows = adm_rows_for_year(year, ids)
        if not rows:
            if year <= 2023:        # known to exist; a transient failure
                print(f"  ADM{year}: download failed (retry later)")
                continue
            break                   # future year not published yet
        by_year[year] = rows
        print(f"  ADM{year}: {len(rows)} schools")

    years = sorted(by_year)
    if not years:
        print("No ADM data downloaded - aborting.")
        return 1

    # Flatten to one row per (school, year), sorted for a readable workbook.
    records = []
    for uid in sorted(ids, key=lambda i: (names.get(i, "").lower(), i)):
        for year in years:
            f = by_year[year].get(uid)
            if not f:
                continue
            appl, adm, enr = f["applications"], f["admitted"], f["enrolled"]
            accept = round(adm / appl, 4) if appl and adm is not None else None
            yld = round(enr / adm, 4) if adm and enr is not None else None
            records.append([uid, names.get(uid, ""), year, appl, adm, enr, accept, yld])

    OUT_DIR.mkdir(exist_ok=True)
    wb = Workbook()
    ws = wb.active
    ws.title = "Admissions History"
    ws.append([
        "ipeds_id", "university_name", "year", "applications",
        "admitted", "enrolled", "acceptance_rate", "yield",
    ])
    for rec in records:
        ws.append(rec)
    wb.save(OUT_XLSX)

    schools = len({r[0] for r in records})
    print(
        f"\nWrote {OUT_XLSX}",
        f"  {len(records)} rows · {schools} schools · years {years[0]}-{years[-1]}",
        "Source: IPEDS ADM (Admissions) survey, nces.ed.gov/ipeds",
        sep="\n",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
