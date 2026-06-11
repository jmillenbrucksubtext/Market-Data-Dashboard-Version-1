"""
fetch-campus-pois.py
--------------------
Pre-fetches campus points of interest (academic buildings, monuments,
athletics, Greek life, nightlife) from OpenStreetMap's Overpass API and
writes one static asset per school:

    assets/campus-pois/<school_key>.json

The University Information tab on market.html loads these assets directly;
live Overpass is only a fallback there. Why prefetch: a per-campus Overpass
query takes 3-4 MINUTES because each tag clause pays to load its global
(key,value) set. Querying each tag ONCE over a bounding box covering all
campuses amortizes that cost - the whole national sweep finishes in roughly
the time of two single-campus queries.

Strategy:
  1. Dedupe campuses (school_key) from data.json campus_locations.
  2. One nationwide bbox query per OSM tag (12 tags). On failure/timeout
     the bbox splits into quadrants and retries (recursive).
  3. Classify + bin elements to campuses within POI_RADIUS_M, cap per
     category, write per-school JSON + _manifest.json.

Run:  python fetch-campus-pois.py            (full sweep)
      python fetch-campus-pois.py --limit 5  (smoke test: write 5 schools)
No SQL credentials needed - reads data.json, talks only to Overpass.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
DATA_JSON = HERE / "data.json"
OUT_DIR = HERE / "assets" / "campus-pois"

POI_RADIUS_M = 3200
CAP_PER_CAT = 250
UA = "SubHouse-Dashboard-POI-prefetch/1.0 (jmillenbruck@subtextliving.com)"

ENDPOINTS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# (key, value, require_name) - one nationwide query each
TAG_CLAUSES = [
    ("building", "university", True),
    ("building", "college", True),
    ("building", "dormitory", True),
    ("amenity", "library", True),
    ("historic", "monument", True),
    ("historic", "memorial", True),
    ("tourism", "attraction", True),
    ("tourism", "artwork", True),
    ("leisure", "stadium", True),
    ("building", "stadium", True),
    ("leisure", "sports_centre", True),
    ("club", "fraternity", False),
    ("club", "sorority", False),
    ("amenity", "fraternity", False),
    ("amenity", "sorority", False),
    ("building", "fraternity", False),
    ("building", "sorority", False),
    ("amenity", "bar", True),
    ("amenity", "pub", True),
    ("amenity", "nightclub", True),
    ("amenity", "biergarten", True),
]

GREEK_WORDS = (
    "Alpha|Beta|Gamma|Delta|Epsilon|Zeta|Eta|Theta|Iota|Kappa|Lambda|Mu|Nu|"
    "Xi|Omicron|Pi|Rho|Sigma|Tau|Upsilon|Phi|Chi|Psi|Omega"
)
RE_FRAT_NAME = re.compile(r"fraternity|sorority", re.I)
RE_GREEK_NAME = re.compile(rf"^({GREEK_WORDS}) ({GREEK_WORDS})\b")


def classify(tags: dict) -> str | None:
    """Mirror of classifyPoi() in market.js - keep the two in sync."""
    amenity = tags.get("amenity", "")
    name = tags.get("name", "")
    if amenity in ("bar", "pub", "nightclub", "biergarten"):
        return "nightlife"
    if (tags.get("club") in ("fraternity", "sorority")
            or amenity in ("fraternity", "sorority")
            or tags.get("building") in ("fraternity", "sorority")
            or RE_FRAT_NAME.search(name)
            or (tags.get("building") and RE_GREEK_NAME.match(name))):
        return "greek"
    if (tags.get("leisure") in ("stadium", "sports_centre")
            or tags.get("building") == "stadium"):
        return "athletics"
    if (tags.get("historic") in ("monument", "memorial")
            or tags.get("tourism") in ("attraction", "artwork")):
        return "landmark"
    if tags.get("building") == "dormitory":
        return "residence"
    if tags.get("building") in ("university", "college") or amenity == "library":
        return "academic"
    return None


def overpass(query: str) -> dict:
    """Try each mirror; on a full sweep failure (e.g. transient local DNS
    outage) pause and retry the whole list before giving up."""
    last = None
    for attempt in range(3):
        if attempt:
            print(f"    all endpoints failed; retrying in 30s (attempt {attempt + 1}/3)")
            time.sleep(30)
        for endpoint in ENDPOINTS:
            try:
                req = urllib.request.Request(
                    endpoint,
                    data=("data=" + urllib.parse.quote(query)).encode(),
                    headers={"Content-Type": "application/x-www-form-urlencoded",
                             "User-Agent": UA},
                )
                with urllib.request.urlopen(req, timeout=960) as r:
                    res = json.loads(r.read().decode())
                if "remark" in res and "timed out" in res.get("remark", ""):
                    raise TimeoutError(res["remark"])
                return res
            except Exception as e:  # noqa: BLE001 - retry next mirror
                print(f"    {endpoint.split('/')[2]}: {e}")
                last = e
    raise last or RuntimeError("all Overpass endpoints failed")


def fetch_tag(key: str, value: str, named: bool, bbox: tuple) -> list[dict]:
    """One tag over a bbox; splits into quadrants on failure."""
    s, w, n, e = bbox
    name_f = '["name"]' if named else ""
    q = f'[out:json][timeout:900];nwr["{key}"="{value}"]{name_f}({s},{w},{n},{e});out tags center bb qt;'
    try:
        res = overpass(q)
        return res.get("elements", [])
    except Exception:
        if (n - s) < 4 and (e - w) < 4:
            raise
        print(f"    splitting bbox for {key}={value} ...")
        mid_lat, mid_lng = (s + n) / 2, (w + e) / 2
        els = []
        for sub in [(s, w, mid_lat, mid_lng), (s, mid_lng, mid_lat, e),
                    (mid_lat, w, n, mid_lng), (mid_lat, mid_lng, n, e)]:
            els.extend(fetch_tag(key, value, named, sub))
            time.sleep(2)
        return els


def main() -> int:
    parser = argparse.ArgumentParser(description="Prefetch campus POIs from Overpass.")
    parser.add_argument("--limit", type=int, default=0, help="only write the first N schools (0 = all)")
    args = parser.parse_args()

    data = json.loads(DATA_JSON.read_text(encoding="utf-8"))

    # dedupe campuses (campus_locations is school x year)
    schools = {}
    for r in data["tables"]["campus_locations"]:
        k = r["school_key"]
        if k not in schools and r["campus_lat"] is not None and r["campus_lng"] is not None:
            schools[k] = r
    schools = list(schools.values())
    print(f"{len(schools)} distinct campuses")

    lats = [s["campus_lat"] for s in schools]
    lngs = [s["campus_lng"] for s in schools]
    bbox = (min(lats) - 0.06, min(lngs) - 0.06, max(lats) + 0.06, max(lngs) + 0.06)
    print(f"bbox: {tuple(round(v, 2) for v in bbox)}")

    # --- one nationwide query per tag ---
    elements: dict[str, dict] = {}
    for key, value, named in TAG_CLAUSES:
        t0 = time.time()
        print(f"  {key}={value} ...", flush=True)
        try:
            els = fetch_tag(key, value, named, bbox)
        except Exception as e:  # noqa: BLE001
            print(f"    FAILED, skipping tag: {e}")
            continue
        for el in els:
            elements[f"{el['type']}/{el['id']}"] = el
        print(f"    {len(els)} elements ({time.time() - t0:.0f}s, total {len(elements)})")
        time.sleep(3)  # be polite between bulk queries

    # --- classify once ---
    pois = []
    for el in elements.values():
        tags = el.get("tags", {})
        bounds = el.get("bounds")
        lat = el.get("lat") or (el.get("center") or {}).get("lat") \
            or (bounds and (bounds["minlat"] + bounds["maxlat"]) / 2)
        lng = el.get("lon") or (el.get("center") or {}).get("lon") \
            or (bounds and (bounds["minlon"] + bounds["maxlon"]) / 2)
        if lat is None or lng is None:
            continue
        cat = classify(tags)
        if not cat:
            continue
        name = tags.get("name") or tags.get("name:en") or "(unnamed)"
        sub = (tags.get("amenity") or tags.get("leisure") or tags.get("historic")
               or tags.get("tourism") or tags.get("building") or "")
        # Notability score for the "well-known landmarks" callouts on the
        # campus map: a Wikipedia/Wikidata link is the strongest signal;
        # footprint area (bounds box, m^2, capped) breaks ties - stadiums,
        # libraries, and student unions are physically big.
        area = 0
        if bounds:
            dy = (bounds["maxlat"] - bounds["minlat"]) * 111320
            dx = (bounds["maxlon"] - bounds["minlon"]) * 111320 * math.cos(math.radians(lat))
            area = min(abs(dx * dy), 150000)
        wiki = 2 if "wikipedia" in tags else (1 if "wikidata" in tags else 0)
        score = int(wiki * 30000 + area)
        pois.append({"cat": cat, "name": name, "lat": lat, "lng": lng,
                     "sub": sub, "score": score})
    print(f"{len(pois)} classified POIs nationwide")

    # --- bin to campuses ---
    # coarse grid index (0.1 deg cells) so each campus only scans nearby POIs
    grid: dict[tuple, list] = {}
    for p in pois:
        grid.setdefault((int(p["lat"] * 10), int(p["lng"] * 10)), []).append(p)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = []
    written = 0
    for s in schools:
        if args.limit and written >= args.limit:
            break
        clat, clng = s["campus_lat"], s["campus_lng"]
        coslat = math.cos(math.radians(clat))
        near = []
        ci, cj = int(clat * 10), int(clng * 10)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                near.extend(grid.get((ci + di, cj + dj), []))
        # exact distance filter
        def dist_m(p):
            dy = (p["lat"] - clat) * 111320
            dx = (p["lng"] - clng) * 111320 * coslat
            return math.hypot(dx, dy)
        in_radius = sorted(
            (p for p in near if dist_m(p) <= POI_RADIUS_M),
            key=dist_m,
        )
        by_cat: dict[str, int] = {}
        keep = []
        for p in in_radius:
            if by_cat.get(p["cat"], 0) >= CAP_PER_CAT:
                continue
            by_cat[p["cat"]] = by_cat.get(p["cat"], 0) + 1
            keep.append(p)
        out = {
            "school_key": s["school_key"],
            "university_name": s["university_name"],
            "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "pois": keep,
        }
        (OUT_DIR / f"{s['school_key']}.json").write_text(
            json.dumps(out, separators=(",", ":")), encoding="utf-8",
        )
        manifest.append({"school_key": s["school_key"],
                         "university_name": s["university_name"],
                         "count": len(keep)})
        written += 1

    (OUT_DIR / "_manifest.json").write_text(
        json.dumps(manifest, indent=1), encoding="utf-8",
    )
    print(f"wrote {written} school files to {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
