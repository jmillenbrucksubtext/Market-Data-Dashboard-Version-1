"""Build shadow-market configs from the markets tracked by the dashboard."""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
from pathlib import Path

import requests


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data.json"
DASHBOARD_PATH = ROOT / "dashboard.js"
CONFIG_PATH = Path(__file__).with_name("markets.json")
AUDIT_PATH = Path(__file__).with_name("market-audit.json")
CACHE_PATH = Path(__file__).with_name(".cache") / "county-envelopes-acs2024.json"
COUNTY_QUERY_URL = (
    "https://tigerweb.geo.census.gov/arcgis/rest/services/"
    "TIGERweb/tigerWMS_ACS2024/MapServer/82/query"
)
TIMEOUT = 45
RING_MILES = [0.5, 1.0, 2.0]
ACS_YEARS = [2024]

# CoStar labels that intentionally differ from dashboard anchor names.
COSTAR_ALIASES = {
    "University of Alabama": "The University of Alabama",
    "University of Mississippi": "The University of Mississippi",
    "University of Michigan": "University of Michigan at Ann Arbor",
    "University of Illinois at Urbana-Champaign": (
        "University of Illinois at Urbana, Champaign"
    ),
    "University of Missouri": "University of Missouri at Columbia",
    "Indiana University Bloomington": "Indiana University at Bloomington",
    "Ohio State University": "The Ohio State University",
    "University of Minnesota Twin Cities": "University of Minnesota",
    "University of Wisconsin Madison": "University of Wisconsin at Madison",
    "University of Iowa": "The University of Iowa",
    "University of Kansas": "The University of Kansas",
    "University of South Florida": "University of South Florida at Tampa",
    "University of Tennessee": "The University of Tennessee, Knoxville",
    "University of Nebraska Lincoln": "University of Nebraska-Lincoln",
    "University of Washington": "University of Washington at Seattle",
    "University of California San Diego": "University of California, San Diego",
    "University of Colorado Boulder": "University of Colorado at Boulder",
    "University of California Berkeley": "University of California, Berkeley",
    "University of Utah": "The University of Utah",
    "University of Maryland College Park": "University of Maryland",
    "Penn State": "Pennsylvania State University",
}


def _load_power4_anchors() -> set[str]:
    source = DASHBOARD_PATH.read_text(encoding="utf-8")
    match = re.search(
        r"const POWER4_ANCHORS = new Set\(\[(.*?)\]\);",
        source,
        re.DOTALL,
    )
    if not match:
        raise RuntimeError("Could not locate POWER4_ANCHORS in dashboard.js")
    return set(re.findall(r'"([^"]+)"', match.group(1)))


def _load_costar_labels(file_path: Path) -> dict[str, str]:
    labels = {}
    with file_path.open("r", encoding="latin-1", newline="") as handle:
        for row in csv.DictReader(handle):
            label = (row.get("University") or "").strip()
            if label:
                labels.setdefault(label.casefold(), label)
    return labels


def _resolve_costar_label(anchor: str, labels: dict[str, str]) -> str:
    requested = COSTAR_ALIASES.get(anchor, anchor)
    exact = labels.get(requested.casefold())
    if exact is None:
        raise RuntimeError(
            f"No exact CoStar university label for {anchor!r}; "
            f"expected {requested!r}"
        )
    return exact


def _load_county_cache() -> dict[str, list[dict]]:
    if not CACHE_PATH.exists():
        return {}
    return json.loads(CACHE_PATH.read_text(encoding="utf-8"))


def _save_county_cache(cache: dict[str, list[dict]]) -> None:
    CACHE_PATH.parent.mkdir(exist_ok=True)
    CACHE_PATH.write_text(
        json.dumps(cache, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def _detect_counties(
    session: requests.Session,
    cache: dict[str, list[dict]],
    lat: float,
    lon: float,
    radius_miles: float,
) -> list[dict]:
    cache_key = f"{lat:.7f},{lon:.7f},{radius_miles:.2f}"
    if cache_key in cache:
        return cache[cache_key]

    lat_offset = radius_miles / 69.0
    lon_offset = radius_miles / (69.0 * math.cos(math.radians(lat)))
    envelope = (
        lon - lon_offset,
        lat - lat_offset,
        lon + lon_offset,
        lat + lat_offset,
    )
    response = session.get(
        COUNTY_QUERY_URL,
        params={
            "geometry": ",".join(str(value) for value in envelope),
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "GEOID,NAME",
            "returnGeometry": "false",
            "f": "json",
        },
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("error"):
        raise RuntimeError(payload["error"])
    counties = sorted(
        (
            {
                "fips": str(feature["attributes"]["GEOID"]),
                "name": feature["attributes"]["NAME"],
            }
            for feature in payload.get("features", [])
        ),
        key=lambda county: county["fips"],
    )
    if not counties:
        raise RuntimeError(f"No county found around {lat}, {lon}")
    cache[cache_key] = counties
    return counties


def build_configs(costar_csv: Path) -> tuple[dict, dict]:
    dashboard_data = json.loads(DATA_PATH.read_text(encoding="utf-8"))["tables"]
    power4 = _load_power4_anchors()
    costar_labels = _load_costar_labels(costar_csv)

    scorecard_by_key = {}
    for row in dashboard_data["scorecard"]:
        market_key = str(row["market_key"])
        if market_key in scorecard_by_key:
            raise RuntimeError(f"Duplicate scorecard market_key {market_key}")
        scorecard_by_key[market_key] = row

    tracked = {
        key: row
        for key, row in scorecard_by_key.items()
        if row["anchor_university"] in power4 or row.get("is_pursuit") == 1
    }
    campuses_by_market: dict[str, list[dict]] = {}
    for campus in dashboard_data.get("campus_locations", []):
        campuses_by_market.setdefault(str(campus["market_key"]), []).append(campus)

    configs = {}
    audit_markets = []
    county_cache = _load_county_cache()
    session = requests.Session()

    for market_key, market in sorted(tracked.items(), key=lambda item: int(item[0])):
        anchor = market["anchor_university"]
        anchor_rows = [
            campus
            for campus in campuses_by_market.get(market_key, [])
            if campus.get("university_name") == anchor
            and campus.get("campus_lat") is not None
            and campus.get("campus_lng") is not None
        ]
        if not anchor_rows:
            raise RuntimeError(
                f"No exact dashboard campus coordinates for {market_key} {anchor}"
            )
        campus_signatures = {
            (
                campus["school_key"],
                float(campus["campus_lat"]),
                float(campus["campus_lng"]),
            )
            for campus in anchor_rows
        }
        if len(campus_signatures) != 1:
            raise RuntimeError(
                f"Ambiguous dashboard campus coordinates for {market_key} {anchor}: "
                f"{sorted(campus_signatures)}"
            )
        school_key, lat, lon = next(iter(campus_signatures))
        costar_university = _resolve_costar_label(anchor, costar_labels)
        counties = _detect_counties(
            session,
            county_cache,
            lat,
            lon,
            max(RING_MILES),
        )
        flags = {
            "power4": anchor in power4,
            "subtext30": market.get("is_subtext30") == 1,
            "pursuit": market.get("is_pursuit") == 1,
        }
        configs[market_key] = {
            "name": anchor,
            "anchor_university": anchor,
            "school_key": school_key,
            "costar_university": costar_university,
            "include_graduates": False,
            "county_fips": [county["fips"] for county in counties],
            "campuses": {anchor: [lat, lon]},
            "ring_miles": RING_MILES,
            "years": ACS_YEARS,
            "scope": flags,
        }
        audit_markets.append({
            "market_key": int(market_key),
            "anchor_university": anchor,
            "city": market.get("city"),
            "state_abbr": market.get("state_abbr"),
            "school_key": school_key,
            "costar_university": costar_university,
            "campus": [lat, lon],
            "counties": counties,
            **flags,
        })

    audit = {
        "scope_rule": (
            "Unique dashboard market_key where anchor_university is in "
            "POWER4_ANCHORS or is_pursuit equals 1"
        ),
        "market_count": len(configs),
        "power4_count": sum(market["power4"] for market in audit_markets),
        "subtext30_count": sum(market["subtext30"] for market in audit_markets),
        "pursuit_count": sum(market["pursuit"] for market in audit_markets),
        "markets": audit_markets,
    }
    _save_county_cache(county_cache)
    return configs, audit


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--costar-csv",
        type=Path,
        default=(
            Path(os.environ["COSTAR_CSV_PATH"])
            if os.environ.get("COSTAR_CSV_PATH")
            else ROOT.parent / "CoStarProperties.csv"
        ),
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate that committed config and audit files are current.",
    )
    args = parser.parse_args()
    costar_csv = args.costar_csv.resolve()
    if not costar_csv.exists():
        raise SystemExit(f"CoStar CSV not found: {costar_csv}")

    configs, audit = build_configs(costar_csv)
    config_text = json.dumps(configs, indent=2) + "\n"
    audit_text = json.dumps(audit, indent=2) + "\n"
    if args.check:
        current_config = (
            CONFIG_PATH.read_text(encoding="utf-8")
            if CONFIG_PATH.exists()
            else ""
        )
        current_audit = (
            AUDIT_PATH.read_text(encoding="utf-8")
            if AUDIT_PATH.exists()
            else ""
        )
        if current_config != config_text or current_audit != audit_text:
            raise SystemExit("Shadow-market configs are not current")
    else:
        CONFIG_PATH.write_text(config_text, encoding="utf-8")
        AUDIT_PATH.write_text(audit_text, encoding="utf-8")

    print(
        "shadow-market scope: "
        f"{audit['market_count']} unique markets "
        f"({audit['power4_count']} Power 4, "
        f"{audit['subtext30_count']} Subtext-30, "
        f"{audit['pursuit_count']} pursuits)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
