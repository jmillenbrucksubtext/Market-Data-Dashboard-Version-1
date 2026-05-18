"""
fetch-campus-boundaries.py
---------------------------
For each tracked market's anchor university in data.json, query the
OpenStreetMap Overpass API for university polygons near its lat/lng, pick the
best fit, and save it as GeoJSON to assets/campus-boundaries/<market_key>.geojson.

Coverage varies: large flagship universities almost always have detailed campus
polygons in OSM; smaller schools may have only a bounding box or nothing.
Already-fetched files are skipped, so re-running is safe and cheap.
Failures are logged to _manifest.json.

Run:
    python fetch-campus-boundaries.py             # all scorecard markets
    python fetch-campus-boundaries.py --s30-only  # Subtext-30 markets only
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# Force UTF-8 stdout/stderr so OSM names with diacritics (e.g. Hawaiʻi, Mānoa,
# São Paulo) don't blow up the cp1252 default console on Windows.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent
OUT_DIR = ROOT / "assets" / "campus-boundaries"
DATA = ROOT / "data.json"
MANIFEST = OUT_DIR / "_manifest.json"

USER_AGENT = "SubtextDashboardCampusFetcher/1.0 (internal team tool; contact: it@subtextliving.com)"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
SEARCH_RADIUS_M = 3000
REQUEST_GAP = 2.0
MAX_RETRIES = 4


def overpass_query(lat: float, lng: float) -> dict:
    """Query Overpass for university polygons within SEARCH_RADIUS_M of (lat, lng)."""
    q = f"""
    [out:json][timeout:25];
    (
      way["amenity"="university"](around:{SEARCH_RADIUS_M},{lat},{lng});
      relation["amenity"="university"](around:{SEARCH_RADIUS_M},{lat},{lng});
      way["amenity"="college"](around:{SEARCH_RADIUS_M},{lat},{lng});
      relation["amenity"="college"](around:{SEARCH_RADIUS_M},{lat},{lng});
    );
    out geom;
    """
    body = urllib.parse.urlencode({"data": q}).encode("utf-8")
    backoff = 5.0
    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(
            OVERPASS_URL, data=body,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 504) and attempt < MAX_RETRIES - 1:
                print(f"   {e.code} — sleeping {backoff:.0f}s")
                time.sleep(backoff)
                backoff *= 2
                continue
            raise
        except Exception as e:
            print(f"   overpass error: {e}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(backoff)
                backoff *= 2
                continue
            return {"elements": []}
    return {"elements": []}


def way_to_polygon(way: dict) -> list[list[float]] | None:
    """Convert an OSM way's geometry to a GeoJSON ring (list of [lon, lat])."""
    geom = way.get("geometry") or []
    if len(geom) < 4:
        return None
    coords = [[pt["lon"], pt["lat"]] for pt in geom]
    # Close the ring if it isn't already closed
    if coords[0] != coords[-1]:
        coords.append(coords[0])
    return coords


def assemble_rings(segments: list[list[list[float]]]) -> list[list[list[float]]]:
    """Assemble a list of OSM linestring segments into closed rings.

    OSM multipolygon relations encode a boundary as multiple line segments
    that share endpoints. To get a polygon, we have to walk them end-to-end:
      - if a segment's first/last point matches the open ring's last point,
        append (reversed if needed)
      - similarly for prepending against the ring's first point
    A ring is complete when its first point equals its last point.
    Disjoint polygons (e.g. main campus + athletic complex) produce multiple
    closed rings here.
    """
    rings: list[list[list[float]]] = []
    open_segs: list[list[list[float]]] = []

    for seg in segments:
        if len(seg) < 2:
            continue
        if seg[0] == seg[-1]:
            rings.append(seg)               # already closed
        else:
            open_segs.append(list(seg))      # copy so we can mutate

    def same(a, b):
        # OSM nodes shared across ways have identical lon/lat
        return a[0] == b[0] and a[1] == b[1]

    while open_segs:
        current = open_segs.pop(0)
        changed = True
        while changed and not same(current[0], current[-1]):
            changed = False
            for i, seg in enumerate(open_segs):
                if same(seg[0], current[-1]):
                    current.extend(seg[1:]);                       open_segs.pop(i); changed = True; break
                if same(seg[-1], current[-1]):
                    current.extend(reversed(seg[:-1]));            open_segs.pop(i); changed = True; break
                if same(seg[-1], current[0]):
                    current = seg + current[1:];                   open_segs.pop(i); changed = True; break
                if same(seg[0], current[0]):
                    current = list(reversed(seg)) + current[1:];   open_segs.pop(i); changed = True; break
        if len(current) >= 4 and same(current[0], current[-1]):
            rings.append(current)
        # else: silently drop incomplete chains
    return rings


def relation_to_multipolygon(rel: dict) -> list[list[list[list[float]]]] | None:
    """Convert an OSM relation into MultiPolygon coordinates.
    Returns list of polygons, each a list of rings, each a list of [lon, lat]."""
    outer_segments = []
    inner_segments = []
    for m in (rel.get("members") or []):
        if m.get("type") != "way":
            continue
        seg = [[pt["lon"], pt["lat"]] for pt in (m.get("geometry") or [])]
        if len(seg) < 2:
            continue
        role = (m.get("role") or "").lower()
        if role == "outer" or not role:
            outer_segments.append(seg)
        elif role == "inner":
            inner_segments.append(seg)

    outer_rings = assemble_rings(outer_segments)
    inner_rings = assemble_rings(inner_segments)
    if not outer_rings:
        return None

    # For each outer ring, attach any inner ring that lies inside it (simple
    # bounding-box test; full point-in-polygon is overkill for v1).
    def bbox(ring):
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return min(xs), min(ys), max(xs), max(ys)

    def inside_bbox(inner_bb, outer_bb):
        return (inner_bb[0] >= outer_bb[0] and inner_bb[1] >= outer_bb[1]
                and inner_bb[2] <= outer_bb[2] and inner_bb[3] <= outer_bb[3])

    polygons = []
    inner_bboxes = [bbox(r) for r in inner_rings]
    for outer in outer_rings:
        ob = bbox(outer)
        rings = [outer]
        for i, ib in enumerate(inner_bboxes):
            if inside_bbox(ib, ob):
                rings.append(inner_rings[i])
        polygons.append(rings)
    return polygons


def polygon_area(ring: list[list[float]]) -> float:
    """Shoelace area of a lon/lat ring in squared degrees (good enough for picking the biggest)."""
    n = len(ring) - 1
    if n < 3:
        return 0
    s = 0.0
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


STOPWORDS = {"university", "of", "the", "at", "a", "an", "&", "and", "college", "institute", "school"}


def name_keywords(university: str) -> set[str]:
    """Extract identifying words from a university name (drop stopwords)."""
    words = [w.strip(".,()&").lower() for w in university.replace("-", " ").split()]
    return {w for w in words if w and w not in STOPWORDS and len(w) > 2}


def best_element(elements: list[dict], university: str, lat: float, lng: float) -> dict | None:
    """Pick the most plausible university polygon.

    Scoring:
      +10  per identifying keyword from the university name that appears in
           the OSM feature's `name` tag (case-insensitive)
      + 2  relation (vs way) — multipolygons usually mean a whole campus
      + log(area) — bigger polygons preferred among equally-named candidates
    """
    import math

    kws = name_keywords(university)
    candidates = []
    for el in elements:
        if el.get("type") == "relation":
            polys = relation_to_multipolygon(el)
            if not polys:
                continue
            area = sum(polygon_area(p[0]) for p in polys)
            base = 2
        elif el.get("type") == "way":
            ring = way_to_polygon(el)
            if not ring:
                continue
            area = polygon_area(ring)
            base = 1
        else:
            continue

        osm_name = (el.get("tags") or {}).get("name", "").lower()
        name_hits = sum(1 for kw in kws if kw in osm_name)
        score = name_hits * 10 + base + math.log(area + 1e-12)
        candidates.append((score, el, osm_name, name_hits, area))

    if not candidates:
        return None
    candidates.sort(key=lambda c: c[0], reverse=True)
    top = candidates[0]
    print(f"   chose '{top[2] or '(unnamed)'}' (name_hits={top[3]}, area={top[4]:.2e})")
    return top[1]


def fetch_campus(market_key: int, university: str, lat: float, lng: float) -> dict:
    print(f"[{market_key}] {university}")
    if lat is None or lng is None:
        return {"market_key": market_key, "university": university, "status": "no_coords"}
    out_path = OUT_DIR / f"{market_key}.geojson"
    if out_path.exists():
        print(f"   already fetched ({out_path.name})")
        return {"market_key": market_key, "university": university, "file": out_path.name, "status": "ok_existing"}

    try:
        data = overpass_query(lat, lng)
    except Exception as e:
        print(f"   query failed: {e}")
        return {"market_key": market_key, "university": university, "status": "query_failed", "error": str(e)}

    elements = data.get("elements", [])
    if not elements:
        print(f"   no university polygon found within {SEARCH_RADIUS_M}m")
        return {"market_key": market_key, "university": university, "status": "no_polygon"}

    best = best_element(elements, university, lat, lng)
    if not best:
        return {"market_key": market_key, "university": university, "status": "no_polygon"}

    # Build a GeoJSON Feature
    feature = {
        "type": "Feature",
        "properties": {
            "market_key": market_key,
            "university": university,
            "osm_type": best.get("type"),
            "osm_id": best.get("id"),
            "osm_name": (best.get("tags") or {}).get("name"),
        },
    }
    if best.get("type") == "way":
        ring = way_to_polygon(best)
        feature["geometry"] = {"type": "Polygon", "coordinates": [ring]}
    else:
        polys = relation_to_multipolygon(best)
        feature["geometry"] = {"type": "MultiPolygon", "coordinates": polys}

    out_path.write_text(json.dumps(feature), encoding="utf-8")
    print(f"   wrote {out_path.name} ({out_path.stat().st_size / 1024:.0f} KB) — matched OSM {best['type']}/{best['id']}")
    return {
        "market_key": market_key,
        "university": university,
        "file": out_path.name,
        "osm_id": best.get("id"),
        "osm_type": best.get("type"),
        "osm_name": (best.get("tags") or {}).get("name"),
        "status": "ok",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--s30-only", action="store_true",
                        help="Limit fetch to Subtext-30 focus markets only.")
    args = parser.parse_args()

    if not DATA.exists():
        sys.exit(f"data.json not found at {DATA}")
    payload = json.loads(DATA.read_text(encoding="utf-8"))

    sc = payload["tables"]["scorecard"]
    campuses = payload["tables"]["campus_locations"]
    anchors = []
    for r in sc:
        if args.s30_only and r.get("is_subtext30") != 1:
            continue
        anchor_school = next(
            (c for c in campuses
             if c["market_key"] == r["market_key"]
             and c["university_name"] == r["anchor_university"]),
            None,
        )
        if anchor_school is None:
            anchor_school = next((c for c in campuses if c["market_key"] == r["market_key"]), None)
        if anchor_school is None:
            anchors.append((r["market_key"], r["anchor_university"], None, None))
            continue
        anchors.append((
            r["market_key"], r["anchor_university"],
            anchor_school["campus_lat"], anchor_school["campus_lng"],
        ))

    scope = "Subtext-30" if args.s30_only else "all scorecard"
    print(f"{scope} markets to process: {len(anchors)}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Preserve existing manifest entries for markets we are not re-fetching this run.
    existing_manifest: dict[int, dict] = {}
    if MANIFEST.exists():
        try:
            for entry in json.loads(MANIFEST.read_text(encoding="utf-8")):
                existing_manifest[entry["market_key"]] = entry
        except (json.JSONDecodeError, KeyError):
            pass

    manifest_by_key: dict[int, dict] = dict(existing_manifest)
    for market_key, name, lat, lng in anchors:
        entry = fetch_campus(market_key, name, lat, lng)
        manifest_by_key[market_key] = entry
        # Only sleep between actual Overpass hits — cached entries return instantly.
        if entry["status"] == "ok":
            time.sleep(REQUEST_GAP)

    manifest = sorted(manifest_by_key.values(), key=lambda e: e["market_key"])
    MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    ok = sum(1 for m in manifest if m["status"] in ("ok", "ok_existing"))
    print(f"\nDone. {ok}/{len(manifest)} polygons available. Manifest: {MANIFEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
