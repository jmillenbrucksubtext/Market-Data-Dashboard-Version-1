"""Census block-group shadow-market analysis used by the static dashboard."""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path

import requests


ACS_BASE = "https://api.census.gov/data/{year}/acs/acs5"
CENSUS_REPORTER_URL = "https://api.censusreporter.org/1.0/data/show/latest"
TIGERWEB_URL = (
    "https://tigerweb.geo.census.gov/arcgis/rest/services/"
    "TIGERweb/tigerWMS_Census2020/MapServer/8/query"
)
TABLE_IDS = ("B25007", "B25032", "B25033", "B01001")
ACS_FIELDS = (
    "?get=B25007_001E,B25007_012E,B25007_013E,B25007_014E,"
    "B25032_013E,B25032_014E,B25032_015E,B25032_016E,B25032_017E,"
    "B25032_018E,B25032_019E,B25032_020E,B25032_021E,"
    "B25033_008E,B25033_009E,B25033_010E,B25033_011E,"
    "B01001_001E,B01001_006E,B01001_007E,B01001_008E,B01001_009E,"
    "B01001_010E,B01001_030E,B01001_031E,B01001_032E,B01001_033E,"
    "B01001_034E,NAME"
)
TIMEOUT = 45
CACHE_DIR = Path(__file__).parent / ".cache"


def _safe_int(value) -> int:
    try:
        number = int(float(value))
        return 0 if number < 0 else number
    except (TypeError, ValueError):
        return 0


def _cache_path(key: str) -> Path:
    CACHE_DIR.mkdir(exist_ok=True)
    digest = hashlib.md5(key.encode("utf-8")).hexdigest()
    return CACHE_DIR / f"{digest}.json"


def _cache_get(key: str):
    path = _cache_path(key)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return None


def _cache_set(key: str, value) -> None:
    _cache_path(key).write_text(json.dumps(value), encoding="utf-8")


def _build_record(get_value, geoid: str, name: str) -> dict:
    renter_units = get_value("B25032", "013")
    renter_2 = get_value("B25032", "016")
    renter_3to4 = get_value("B25032", "017")
    renter_5to9 = get_value("B25032", "018")
    renter_10to19 = get_value("B25032", "019")
    renter_20to49 = get_value("B25032", "020")
    renter_50plus = get_value("B25032", "021")

    return {
        "geoid": geoid,
        "name": name,
        "total_units": get_value("B25007", "001"),
        "renter_total": get_value("B25007", "012"),
        "renter_15_24": get_value("B25007", "013"),
        "renter_25_34": get_value("B25007", "014"),
        "renter_units_b25032": renter_units,
        "renter_units_2to4": renter_2 + renter_3to4,
        "renter_units_50plus": renter_50plus,
        "renter_units_sub50": max(0, renter_units - renter_50plus),
        "fiveplus_sub50_units": renter_5to9 + renter_10to19 + renter_20to49,
        "renter_pop_total": get_value("B25033", "008"),
        "renter_pop_1unit": get_value("B25033", "009"),
        "renter_pop_2to4": get_value("B25033", "010"),
        "renter_pop_5plus": get_value("B25033", "011"),
        "total_pop": get_value("B01001", "001"),
        "pop_15_17": get_value("B01001", "006") + get_value("B01001", "030"),
        "pop_18_19": get_value("B01001", "007") + get_value("B01001", "031"),
        "pop_20_21": (
            get_value("B01001", "008")
            + get_value("B01001", "009")
            + get_value("B01001", "032")
            + get_value("B01001", "033")
        ),
        "pop_22_24": get_value("B01001", "010") + get_value("B01001", "034"),
    }


def _parse_census_api(rows: list[list]) -> list[dict]:
    columns = {name: index for index, name in enumerate(rows[0])}
    records = []
    for row in rows[1:]:
        geoid = row[columns["ucgid"]].split("US")[-1]

        def get_value(table: str, line: str) -> int:
            return _safe_int(row[columns[f"{table}_{line}E"]])

        records.append(_build_record(get_value, geoid, row[columns["NAME"]]))
    return records


def _fetch_census_reporter(year: int, county_fips: list[str]) -> list[dict]:
    records = []
    for fips in county_fips:
        response = requests.get(
            CENSUS_REPORTER_URL,
            params={
                "table_ids": ",".join(TABLE_IDS),
                "geo_ids": f"150|05000US{fips}",
            },
            timeout=TIMEOUT,
        )
        response.raise_for_status()
        payload = response.json()
        release_id = payload.get("release", {}).get("id")
        if release_id != f"acs{year}_5yr":
            raise RuntimeError(
                f"Census Reporter returned {release_id}, not ACS {year}. "
                "Set CENSUS_API_KEY for historical runs."
            )
        geography = payload.get("geography", {})
        for full_geoid, tables in payload.get("data", {}).items():
            if not full_geoid.startswith("15000US"):
                continue

            def get_value(table: str, line: str) -> int:
                return _safe_int(
                    tables.get(table, {})
                    .get("estimate", {})
                    .get(f"{table}{line}")
                )

            records.append(
                _build_record(
                    get_value,
                    full_geoid.removeprefix("15000US"),
                    geography.get(full_geoid, {}).get("name", full_geoid),
                )
            )
    return records


def fetch_acs(year: int, county_fips: list[str]) -> list[dict]:
    cache_key = f"acs_{year}_{'_'.join(sorted(county_fips))}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    api_key = os.environ.get("CENSUS_API_KEY", "")
    records = []
    try:
        for fips in county_fips:
            url = (
                ACS_BASE.format(year=year)
                + ACS_FIELDS
                + f"&ucgid=pseudo(0500000US{fips}$1500000)"
            )
            if api_key:
                url += f"&key={api_key}"
            response = requests.get(url, timeout=TIMEOUT)
            response.raise_for_status()
            records.extend(_parse_census_api(response.json()))
    except (requests.RequestException, ValueError, KeyError):
        if api_key:
            raise
        records = _fetch_census_reporter(year, county_fips)

    _cache_set(cache_key, records)
    return records


def fetch_centroids(county_fips: list[str]) -> dict[str, tuple[float, float]]:
    cache_key = f"centroids_{'_'.join(sorted(county_fips))}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return {geoid: tuple(coords) for geoid, coords in cached.items()}

    centroids = {}
    for fips in county_fips:
        state, county = fips[:2], fips[-3:]
        offset = 0
        while True:
            response = requests.get(
                TIGERWEB_URL,
                params={
                    "where": f"STATE='{state}' AND COUNTY='{county}'",
                    "outFields": "GEOID,CENTLAT,CENTLON",
                    "returnGeometry": "false",
                    "f": "json",
                    "resultRecordCount": 1000,
                    "resultOffset": offset,
                },
                timeout=TIMEOUT,
            )
            response.raise_for_status()
            payload = response.json()
            features = payload.get("features", [])
            for feature in features:
                attrs = feature["attributes"]
                centroids[attrs["GEOID"]] = (
                    float(attrs["CENTLAT"]),
                    float(attrs["CENTLON"]),
                )
            if not payload.get("exceededTransferLimit") or not features:
                break
            offset += len(features)

    _cache_set(cache_key, {k: list(v) for k, v in centroids.items()})
    return centroids


def haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 3958.8
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    value = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    return radius * 2 * math.asin(min(1, math.sqrt(value)))


def _ring_labels(ring_miles: list[float]) -> list[str]:
    labels = []
    previous = 0
    for boundary in ring_miles:
        low = int(previous) if previous == int(previous) else previous
        high = int(boundary) if boundary == int(boundary) else boundary
        labels.append(f"{low}-{high}mi")
        previous = boundary
    return labels


def _shadow_metrics(record: dict) -> dict:
    renter_units = record["renter_units_b25032"]
    sub50_units = record["renter_units_sub50"]
    units_50plus = record["renter_units_50plus"]
    sub50_ratio = sub50_units / renter_units if renter_units else 0
    fiveplus_total = record["fiveplus_sub50_units"] + units_50plus
    fiveplus_sub50_ratio = (
        record["fiveplus_sub50_units"] / fiveplus_total if fiveplus_total else 0
    )
    renter_pop_sub50 = (
        record["renter_pop_1unit"]
        + record["renter_pop_2to4"]
        + record["renter_pop_5plus"] * fiveplus_sub50_ratio
    )
    average_occupancy = renter_pop_sub50 / sub50_units if sub50_units else 0
    shadow_hhs = record["renter_15_24"] * sub50_ratio
    return {
        "sub50_ratio": sub50_ratio,
        "renter_pop_sub50": renter_pop_sub50,
        "avg_occ_sub50": average_occupancy,
        "shadow_hhs": shadow_hhs,
        "shadow_pop": shadow_hhs * average_occupancy,
    }


def analyze(config: dict, year: int) -> dict:
    acs = fetch_acs(year, config["county_fips"])
    centroids = fetch_centroids(config["county_fips"])
    ring_miles = config["ring_miles"]
    ring_labels = _ring_labels(ring_miles)
    campuses = config["campuses"]
    points = []
    total_accumulator = {
        "block_groups": 0,
        "shadow_pop": 0.0,
        "shadow_hhs": 0.0,
        "renter_15_24": 0,
        "renter_units_sub50": 0,
    }
    ring_accumulators = {
        label: {
            "block_groups": 0,
            "shadow_pop": 0.0,
            "shadow_hhs": 0.0,
            "renter_15_24": 0,
            "renter_units_sub50": 0,
        }
        for label in ring_labels
    }

    for record in acs:
        coords = centroids.get(record["geoid"])
        if not coords:
            continue
        lat, lon = coords
        nearest_name, distance = min(
            (
                (name, haversine_miles(lat, lon, campus[0], campus[1]))
                for name, campus in campuses.items()
            ),
            key=lambda item: item[1],
        )
        ring = next(
            (
                label
                for boundary, label in zip(ring_miles, ring_labels)
                if distance <= boundary
            ),
            None,
        )
        if ring is None:
            continue
        metrics = _shadow_metrics(record)
        for accumulator in (total_accumulator, ring_accumulators[ring]):
            accumulator["block_groups"] += 1
            accumulator["shadow_pop"] += metrics["shadow_pop"]
            accumulator["shadow_hhs"] += metrics["shadow_hhs"]
            accumulator["renter_15_24"] += record["renter_15_24"]
            accumulator["renter_units_sub50"] += record["renter_units_sub50"]
        points.append(
            {
                "geoid": record["geoid"],
                "name": record["name"],
                "lat": lat,
                "lon": lon,
                "ring": ring,
                "distance_mi": round(distance, 2),
                "nearest_campus": nearest_name,
                "shadow_pop": round(metrics["shadow_pop"], 2),
                "shadow_hhs": round(metrics["shadow_hhs"], 2),
                "renter_15_24": record["renter_15_24"],
                "renter_units_sub50": record["renter_units_sub50"],
                "renter_total": record["renter_total"],
                "total_units": record["total_units"],
            }
        )

    totals = {
        **total_accumulator,
        "shadow_pop": round(total_accumulator["shadow_pop"], 2),
        "shadow_hhs": round(total_accumulator["shadow_hhs"], 2),
    }
    rings = {
        label: {
            **accumulator,
            "shadow_pop": round(accumulator["shadow_pop"], 2),
            "shadow_hhs": round(accumulator["shadow_hhs"], 2),
        }
        for label, accumulator in ring_accumulators.items()
    }

    points.sort(key=lambda point: point["shadow_pop"], reverse=True)
    return {
        "methodology_version": 1,
        "year": year,
        "ring_miles": ring_miles,
        "ring_labels": ring_labels,
        "campuses": campuses,
        "total": totals,
        "rings": rings,
        "points": points,
    }
