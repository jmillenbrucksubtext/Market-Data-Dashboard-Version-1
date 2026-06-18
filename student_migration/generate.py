"""Generate per-market student-origin assets from the MigrationOnly export."""

from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = ROOT / "assets" / "student-origin"
DEFAULT_AUDIT_PATH = ROOT / "student_migration" / "audit.json"
DEFAULT_GAZETTEER_URL = (
    "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/"
    "2021_Gazetteer/2021_Gaz_cbsa_national.zip"
)
REQUIRED_COLUMNS = {"NAME", "UNIQUEID", "State", "CBSAID", "MigrantsIn", "FTE"}

STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii",
    "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine",
    "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska",
    "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico",
    "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
    "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island",
    "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
    "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}


def parse_int(value: str, field: str, row_number: int) -> int:
    text = (value or "").strip()
    if text == "":
        raise ValueError(f"Row {row_number}: {field} is blank")
    number = float(text)
    if not number.is_integer():
        raise ValueError(f"Row {row_number}: {field} must be an integer, got {text!r}")
    return int(number)


def resolve_source(explicit: str | None) -> Path:
    candidates = [
        explicit,
        os.environ.get("STUDENT_MIGRATION_CSV_PATH"),
        str(ROOT.parent / "MigrationOnly.csv"),
        str(ROOT.parent / "MigrationOnly.xlsx"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).expanduser().is_file():
            path = Path(candidate).expanduser().resolve()
            if path.suffix.lower() != ".csv":
                raise ValueError(
                    f"{path} is not CSV. Export the MigrationOnly worksheet as CSV "
                    "or pass the CSV path with --source."
                )
            return path
    raise FileNotFoundError(
        "Student migration source not found. Pass --source, set "
        "STUDENT_MIGRATION_CSV_PATH, or place MigrationOnly.csv beside the repository."
    )


def ensure_gazetteer(explicit: str | None, url: str) -> Path:
    if explicit:
        path = Path(explicit).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(path)
        return path

    cache_dir = ROOT / "student_migration" / ".cache"
    text_path = cache_dir / "2021_Gaz_cbsa_national.txt"
    if text_path.is_file():
        return text_path

    cache_dir.mkdir(parents=True, exist_ok=True)
    zip_path = cache_dir / "2021_Gaz_cbsa_national.zip"
    print(f"Downloading Census CBSA Gazetteer: {url}")
    urllib.request.urlretrieve(url, zip_path)
    with zipfile.ZipFile(zip_path) as archive:
        member = next(
            (name for name in archive.namelist() if name.lower().endswith(".txt")),
            None,
        )
        if not member:
            raise RuntimeError("Census Gazetteer archive did not contain a text file")
        with archive.open(member) as source, text_path.open("wb") as target:
            shutil.copyfileobj(source, target)
    return text_path


def load_gazetteer(path: Path) -> dict[str, dict[str, Any]]:
    lookup: dict[str, dict[str, Any]] = {}
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        for raw in reader:
            row = {
                (key or "").strip(): (value or "").strip()
                for key, value in raw.items()
            }
            cbsa_id = row.get("GEOID", "")
            if not cbsa_id:
                continue
            lookup[cbsa_id] = {
                "cbsa_id": cbsa_id,
                "name": row["NAME"],
                "type": "Metro Area" if row.get("CBSA_TYPE") == "1" else "Micro Area",
                "lat": float(row["INTPTLAT"]),
                "lon": float(row["INTPTLONG"]),
            }
    return lookup


def load_source(path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    duplicate_rows: list[dict[str, Any]] = []
    seen: dict[tuple[str, str, str], dict[str, Any]] = {}
    source_headers: list[str] = []

    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        source_headers = [header or "" for header in (reader.fieldnames or [])]
        missing = REQUIRED_COLUMNS - set(source_headers)
        if missing:
            raise ValueError(f"Source is missing required columns: {sorted(missing)}")

        for row_number, raw in enumerate(reader, start=2):
            row = {
                "source_row": row_number,
                "name": (raw["NAME"] or "").strip(),
                "ipeds_id": parse_int(raw["UNIQUEID"], "UNIQUEID", row_number),
                "state": (raw["State"] or "").strip().upper(),
                "cbsa_id": (raw["CBSAID"] or "").strip().upper(),
                "migrants_in": parse_int(raw["MigrantsIn"], "MigrantsIn", row_number),
                "fte": parse_int(raw["FTE"], "FTE", row_number),
            }
            if not row["name"]:
                raise ValueError(f"Row {row_number}: NAME is blank")
            if row["state"] not in STATE_NAMES:
                raise ValueError(
                    f"Row {row_number}: unsupported State value {row['state']!r}"
                )
            if row["migrants_in"] < 0:
                raise ValueError(f"Row {row_number}: MigrantsIn cannot be negative")

            key = (str(row["ipeds_id"]), row["state"], row["cbsa_id"])
            existing = seen.get(key)
            if existing:
                comparable = ("name", "ipeds_id", "state", "cbsa_id", "migrants_in", "fte")
                if any(existing[field] != row[field] for field in comparable):
                    raise ValueError(
                        "Conflicting duplicate school/state/CBSA records at rows "
                        f"{existing['source_row']} and {row_number}: {key}"
                    )
                duplicate_rows.append({
                    "removed_source_row": row_number,
                    "kept_source_row": existing["source_row"],
                    "ipeds_id": row["ipeds_id"],
                    "state": row["state"],
                    "cbsa_id": row["cbsa_id"],
                    "migrants_in": row["migrants_in"],
                })
                continue
            seen[key] = row
            rows.append(row)

    by_school: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_school[row["ipeds_id"]].append(row)
    for ipeds_id, school_rows in by_school.items():
        names = {row["name"] for row in school_rows}
        ftes = {row["fte"] for row in school_rows}
        if len(names) != 1:
            raise ValueError(f"IPEDS {ipeds_id} has inconsistent NAME values: {names}")
        if len(ftes) != 1:
            raise ValueError(f"IPEDS {ipeds_id} has inconsistent FTE values: {ftes}")

    audit = {
        "source_file": path.name,
        "source_headers": source_headers,
        "reporting_period": None,
        "reporting_period_note": "The source file does not contain a reporting-period field.",
        "input_rows": len(rows) + len(duplicate_rows),
        "retained_rows": len(rows),
        "duplicate_records_removed": duplicate_rows,
        "zero_count_records": sum(row["migrants_in"] == 0 for row in rows),
        "suppressed_counts": [],
        "suppression_note": (
            "The source contains numeric counts only and no suppression marker. "
            "Zero values are reported separately and are not classified as suppressed."
        ),
    }
    return rows, audit


def unique_campuses(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[tuple[float, float], dict[str, Any]] = {}
    for row in rows:
        if row.get("campus_lat") is None or row.get("campus_lng") is None:
            continue
        key = (float(row["campus_lat"]), float(row["campus_lng"]))
        unique[key] = {
            "lat": key[0],
            "lon": key[1],
            "name": row["university_name"],
        }
    return list(unique.values())


def build_dashboard_index(data_path: Path) -> tuple[dict[int, dict[str, Any]], dict[int, Any]]:
    data = json.loads(data_path.read_text(encoding="utf-8"))
    tables = data["tables"]
    markets = {int(row["market_key"]): row for row in tables["scorecard"]}
    campus_by_ipeds: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in tables["campus_locations"]:
        if row.get("ipeds_id") is not None:
            campus_by_ipeds[int(row["ipeds_id"])].append(row)

    index: dict[int, dict[str, Any]] = {}
    for ipeds_id, campus_rows in campus_by_ipeds.items():
        market_keys = {int(row["market_key"]) for row in campus_rows}
        if len(market_keys) != 1:
            raise ValueError(
                f"IPEDS {ipeds_id} maps to multiple dashboard markets: {sorted(market_keys)}"
            )
        market_key = next(iter(market_keys))
        names = sorted({row["university_name"] for row in campus_rows})
        index[ipeds_id] = {
            "market_key": market_key,
            "dashboard_names": names,
            "campuses": unique_campuses(campus_rows),
        }
    return index, markets


def build_school_asset(
    school_rows: list[dict[str, Any]],
    dashboard_match: dict[str, Any],
    market: dict[str, Any],
    gazetteer: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    first = school_rows[0]
    home_state = market["state_abbr"]
    total = sum(row["migrants_in"] for row in school_rows)
    in_state = sum(
        row["migrants_in"] for row in school_rows if row["state"] == home_state
    )
    out_of_state = total - in_state

    state_totals: dict[str, int] = defaultdict(int)
    cbsa_totals: dict[str, int] = defaultdict(int)
    cbsa_states: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for row in school_rows:
        state_totals[row["state"]] += row["migrants_in"]
        cbsa_totals[row["cbsa_id"]] += row["migrants_in"]
        cbsa_states[row["cbsa_id"]][row["state"]] += row["migrants_in"]

    states = [
        {
            "abbr": abbr,
            "name": STATE_NAMES[abbr],
            "migrants_in": count,
            "share": count / total if total else 0,
            "in_state_group_share": (
                count / in_state if abbr == home_state and in_state else 0
            ),
            "out_of_state_group_share": (
                count / out_of_state if abbr != home_state and out_of_state else 0
            ),
            "is_home_state": abbr == home_state,
        }
        for abbr, count in state_totals.items()
    ]
    states.sort(key=lambda row: (-row["migrants_in"], row["abbr"]))
    for rank, row in enumerate(states, start=1):
        row["rank"] = rank

    points: list[dict[str, Any]] = []
    unlocated = 0
    unlocated_in_state = 0
    unlocated_out_of_state = 0
    unlocated_codes: dict[str, int] = {}
    for cbsa_id, count in cbsa_totals.items():
        geography = gazetteer.get(cbsa_id)
        if not geography:
            unlocated += count
            unlocated_in_state += cbsa_states[cbsa_id].get(home_state, 0)
            unlocated_out_of_state += (
                count - cbsa_states[cbsa_id].get(home_state, 0)
            )
            unlocated_codes[cbsa_id] = count
            continue
        in_state_count = cbsa_states[cbsa_id].get(home_state, 0)
        out_of_state_count = count - in_state_count
        state_breakdown = [
            {
                "abbr": abbr,
                "name": STATE_NAMES[abbr],
                "migrants_in": state_count,
                "share_of_school": state_count / total if total else 0,
            }
            for abbr, state_count in cbsa_states[cbsa_id].items()
        ]
        state_breakdown.sort(key=lambda row: (-row["migrants_in"], row["abbr"]))
        points.append({
            **geography,
            "migrants_in": count,
            "share": count / total if total else 0,
            "in_state_migrants": in_state_count,
            "out_of_state_migrants": out_of_state_count,
            "in_state_share": in_state_count / total if total else 0,
            "out_of_state_share": out_of_state_count / total if total else 0,
            "in_state_group_share": (
                in_state_count / in_state if in_state else 0
            ),
            "out_of_state_group_share": (
                out_of_state_count / out_of_state if out_of_state else 0
            ),
            "state_breakdown": state_breakdown,
        })
    points.sort(key=lambda row: (-row["migrants_in"], row["cbsa_id"]))
    for rank, row in enumerate(points, start=1):
        row["rank"] = rank

    return {
        "ipeds_id": first["ipeds_id"],
        "source_name": first["name"],
        "dashboard_names": dashboard_match["dashboard_names"],
        "market_key": dashboard_match["market_key"],
        "is_anchor": False,
        "home_state": home_state,
        "fte": first["fte"],
        "campuses": dashboard_match["campuses"],
        "totals": {
            "migrants_in": total,
            "fte": first["fte"],
            "origin_states": sum(count > 0 for count in state_totals.values()),
            "origin_cbsas": sum(count > 0 for count in cbsa_totals.values()),
            "mapped_cbsas": sum(point["migrants_in"] > 0 for point in points),
            "mapped_migrants": sum(point["migrants_in"] for point in points),
            "unlocated_migrants": unlocated,
            "unlocated_in_state": unlocated_in_state,
            "unlocated_out_of_state": unlocated_out_of_state,
            "in_state": in_state,
            "out_of_state": out_of_state,
            "in_state_share": in_state / total if total else 0,
            "out_of_state_share": out_of_state / total if total else 0,
            "share_check": (
                sum(row["migrants_in"] / total for row in school_rows)
                if total else 0
            ),
            "in_state_group_share_check": (
                sum(
                    point["in_state_group_share"]
                    for point in points
                )
                + (unlocated_in_state / in_state if in_state else 0)
            ),
            "out_of_state_group_share_check": (
                sum(
                    point["out_of_state_group_share"]
                    for point in points
                )
                + (unlocated_out_of_state / out_of_state if out_of_state else 0)
            ),
        },
        "unlocated_cbsa_codes": unlocated_codes,
        "states": states,
        "points": points,
        "top_origins": points[:15],
    }


def generate(
    source_path: Path,
    gazetteer_path: Path,
    data_path: Path,
    output_dir: Path,
    audit_path: Path,
) -> dict[str, Any]:
    source_rows, source_audit = load_source(source_path)
    gazetteer = load_gazetteer(gazetteer_path)
    dashboard_index, markets = build_dashboard_index(data_path)

    by_school: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in source_rows:
        by_school[row["ipeds_id"]].append(row)

    matched: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []
    schools_by_market: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for ipeds_id, school_rows in sorted(by_school.items()):
        match = dashboard_index.get(ipeds_id)
        if not match:
            unmatched.append({
                "ipeds_id": ipeds_id,
                "source_name": school_rows[0]["name"],
                "source_rows": len(school_rows),
            })
            continue
        market_key = match["market_key"]
        market = markets[market_key]
        school_asset = build_school_asset(school_rows, match, market, gazetteer)
        checks = [("share_check", school_asset["totals"]["migrants_in"])]
        checks.append(("in_state_group_share_check", school_asset["totals"]["in_state"]))
        checks.append((
            "out_of_state_group_share_check",
            school_asset["totals"]["out_of_state"],
        ))
        for check_name, denominator in checks:
            if not denominator:
                continue
            check_value = school_asset["totals"][check_name]
            if abs(check_value - 1) > 1e-9:
                raise ValueError(
                    f"IPEDS {ipeds_id} failed {check_name}: {check_value}"
                )
        anchor_ipeds = {
            int(row_id)
            for row_id, item in dashboard_index.items()
            if item["market_key"] == market_key
            and market["anchor_university"] in item["dashboard_names"]
        }
        school_asset["is_anchor"] = ipeds_id in anchor_ipeds
        schools_by_market[market_key].append(school_asset)
        matched.append({
            "ipeds_id": ipeds_id,
            "source_name": school_rows[0]["name"],
            "dashboard_names": match["dashboard_names"],
            "market_key": market_key,
            "anchor_university": market["anchor_university"],
            "source_rows": len(school_rows),
            "migrants_in": school_asset["totals"]["migrants_in"],
            "asset": f"assets/student-origin/{market_key}.json",
        })

    output_dir.mkdir(parents=True, exist_ok=True)
    generated_assets: list[str] = []
    generated_at = datetime.now(timezone.utc).isoformat()
    for market_key, schools in sorted(schools_by_market.items()):
        schools.sort(key=lambda row: (not row["is_anchor"], row["source_name"]))
        market = markets[market_key]
        payload = {
            "schema_version": 1,
            "generated_at": generated_at,
            "market_key": market_key,
            "anchor_university": market["anchor_university"],
            "market_state": market["state_abbr"],
            "source": {
                "file": source_path.name,
                "reporting_period": None,
                "reporting_period_note": (
                    "The MigrationOnly source has no reporting-period field."
                ),
                "geography": (
                    "Origin state and CBSA. CBSA names and internal-point "
                    "coordinates use the U.S. Census Bureau 2021 Gazetteer."
                ),
                "count_field": "MigrantsIn",
                "display_metric": (
                    "The in-state map divides each in-state origin by total "
                    "in-state origins. The out-of-state map divides each "
                    "out-of-state origin by total out-of-state origins. Each "
                    "dataset independently sums to 100% per school."
                ),
                "school_identifier": "UNIQUEID (IPEDS ID)",
                "fte_field": "FTE",
            },
            "schools": schools,
        }
        output_path = output_dir / f"{market_key}.json"
        output_path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        generated_assets.append(str(output_path.relative_to(ROOT)).replace("\\", "/"))

    manifest = {
        "schema_version": 1,
        "generated_at": generated_at,
        "markets": [
            {
                "market_key": market_key,
                "anchor_university": markets[market_key]["anchor_university"],
                "school_count": len(schools),
                "file": f"{market_key}.json",
            }
            for market_key, schools in sorted(schools_by_market.items())
        ],
    }
    (output_dir / "_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    generated_assets.append(
        str((output_dir / "_manifest.json").relative_to(ROOT)).replace("\\", "/")
    )

    missing_cbsa_codes = sorted({
        row["cbsa_id"]
        for row in source_rows
        if row["cbsa_id"] not in gazetteer
    })
    audit = {
        "generated_at": generated_at,
        **source_audit,
        "school_identifier": "UNIQUEID matched exactly to campus_locations.ipeds_id",
        "source_school_count": len(by_school),
        "matched_school_count": len(matched),
        "unmatched_school_count": len(unmatched),
        "matched_markets": matched,
        "unmatched_schools": unmatched,
        "cbsa_gazetteer": {
            "file": gazetteer_path.name,
            "vintage": 2021,
            "source_url": DEFAULT_GAZETTEER_URL,
            "source_cbsa_code_count": len({row["cbsa_id"] for row in source_rows}),
            "mapped_cbsa_code_count": len({
                row["cbsa_id"] for row in source_rows if row["cbsa_id"] in gazetteer
            }),
            "unmapped_cbsa_codes": missing_cbsa_codes,
            "unmapped_note": (
                "99999 and NA are retained in state totals but cannot be plotted "
                "as CBSA centroids."
            ),
        },
        "generated_assets": generated_assets,
    }
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    audit_path.write_text(
        json.dumps(audit, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return audit


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", help="Path to MigrationOnly.csv")
    parser.add_argument("--gazetteer", help="Path to Census CBSA Gazetteer text file")
    parser.add_argument("--gazetteer-url", default=DEFAULT_GAZETTEER_URL)
    parser.add_argument("--data-json", default=str(ROOT / "data.json"))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--audit", default=str(DEFAULT_AUDIT_PATH))
    args = parser.parse_args()

    source_path = resolve_source(args.source)
    gazetteer_path = ensure_gazetteer(args.gazetteer, args.gazetteer_url)
    audit = generate(
        source_path=source_path,
        gazetteer_path=gazetteer_path,
        data_path=Path(args.data_json).resolve(),
        output_dir=Path(args.output_dir).resolve(),
        audit_path=Path(args.audit).resolve(),
    )
    print(
        "student migration: "
        f"{audit['matched_school_count']} schools matched, "
        f"{audit['unmatched_school_count']} unmatched, "
        f"{len(audit['generated_assets']) - 1} market assets generated"
    )


if __name__ == "__main__":
    main()
