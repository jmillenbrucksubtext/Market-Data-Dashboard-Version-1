"""
apply_overrides.py
------------------
Applies manual data corrections from overrides.json to data.json.

Why this exists: every chart and table on the dashboard (Comps, Pipeline,
University Info, KPIs, maps) renders straight from rows in data.json, and
data.json is regenerated from Azure SQL by export-data.py every Monday.
Editing data.json by hand therefore only survives until the next refresh.
Instead, corrections live in overrides.json and are re-applied:

  1. automatically at the end of every export-data.py run (including the
     weekly scheduled refresh), and
  2. on demand via this script, to patch the current data.json immediately
     without touching SQL.

Usage:
    python apply_overrides.py            # apply overrides.json to data.json
    python apply_overrides.py --dry-run  # report what would change, write nothing

If you run one of the load_*.py patchers manually and it rewrites a table
you have overridden, re-run this script afterwards.

overrides.json format - one entry per correction:

    {
      "overrides": [
        {
          "table": "properties",                 // key under data.json "tables"
          "match": {"property_key": 1234},       // ALL pairs must equal the row's
          "set":   {"beds": 540, "units": 180},  // fields to overwrite
          "note":  "CoStar double-counts phase 2 beds",
          "added": "2026-07-01",
          "expires": "2026-12-31"                // optional; skipped after this date
        },
        {
          "table": "properties",                 // drop bad rows entirely
          "match": {"property_key": 9999},
          "action": "remove",
          "note": "duplicate of property 1234"
        },
        {
          "table": "properties",                 // add a missing row
          "action": "add",
          "row": {"property_key": 100001, "market_key": 42, "property_name": "..."},
          "note": "project missing from CoStar feed"
        }
      ]
    }

Notes:
  - "match" can use any combination of columns (e.g. market_key + year_ for
    market_history rows). An entry that matches several rows updates all of
    them and says so in the report.
  - An entry that matches NOTHING is flagged loudly - it usually means the
    upstream row changed keys or disappeared, so the override is stale.
  - A "set" whose values already equal the data is flagged as redundant -
    the source data was likely fixed and the override can be retired.
  - Row values may be numbers, strings, or whole nested objects/lists
    (e.g. replace a unit_mix row's "beds_by_type" dict wholesale).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

HERE = Path(__file__).parent
DATA_JSON = HERE / "data.json"
OVERRIDES_JSON = HERE / "overrides.json"


def load_overrides(path: Path = OVERRIDES_JSON) -> list[dict]:
    """Returns the override entries, or [] if the file is absent/empty."""
    if not path.exists():
        return []
    doc = json.loads(path.read_text(encoding="utf-8"))
    return doc.get("overrides", [])


def _values_equal(a, b) -> bool:
    """Loose equality: 540 == 540.0 == "540" so JSON typing quirks don't
    cause silent mismatches between overrides.json and data.json."""
    if a == b:
        return True
    try:
        return float(a) == float(b)
    except (TypeError, ValueError):
        return str(a) == str(b)


def _row_matches(row: dict, match: dict) -> bool:
    return all(_values_equal(row.get(k), v) for k, v in match.items())


def _describe(entry: dict) -> str:
    match = entry.get("match", entry.get("row", {}))
    return f"{entry.get('table', '?')} {json.dumps(match, default=str)}"


def apply_overrides(payload: dict, overrides: list[dict]) -> list[str]:
    """Mutates payload in place. Returns human-readable report lines
    (one per entry) that the caller should print/log."""
    report: list[str] = []
    applied: list[dict] = []
    today = dt.date.today().isoformat()

    for entry in overrides:
        desc = _describe(entry)
        note = entry.get("note", "")
        action = entry.get("action", "set")

        expires = entry.get("expires")
        if expires and today > str(expires):
            report.append(f"SKIP (expired {expires}): {desc} - {note}")
            continue

        table_name = entry.get("table")
        table = payload.get("tables", {}).get(table_name)
        if table is None:
            report.append(f"WARN unknown table '{table_name}': {desc} - "
                          f"override not applied, check spelling")
            continue

        if action == "add":
            row = entry.get("row")
            if not isinstance(row, dict):
                report.append(f"WARN 'add' entry missing 'row': {desc}")
                continue
            table.append(row)
            report.append(f"ADD row to {table_name}: {desc} - {note}")
            applied.append(entry)
            continue

        match = entry.get("match")
        if not match:
            report.append(f"WARN entry missing 'match': {desc}")
            continue
        hits = [r for r in table if _row_matches(r, match)]

        if not hits:
            report.append(f"WARN STALE (no matching row): {desc} - {note} - "
                          f"upstream row gone or keys changed; fix or remove this override")
            continue

        if action == "remove":
            table[:] = [r for r in table if not _row_matches(r, match)]
            report.append(f"REMOVE {len(hits)} row(s) from {table_name}: {desc} - {note}")
            applied.append(entry)
            continue

        # default: set fields
        fields = entry.get("set", {})
        if not fields:
            report.append(f"WARN entry has no 'set' fields: {desc}")
            continue
        changed = 0
        for row in hits:
            for k, v in fields.items():
                if not _values_equal(row.get(k), v):
                    changed += 1
                row[k] = v
        if changed == 0:
            report.append(f"REDUNDANT (data already matches): {desc} - {note} - "
                          f"source may be fixed; consider retiring this override")
        else:
            report.append(f"SET {list(fields)} on {len(hits)} row(s) in "
                          f"{table_name}: {desc} - {note}")
        applied.append(entry)

    # Traceability: stamp what was applied so a stale-looking figure can be
    # traced back to overrides.json instead of the SQL source.
    payload["overrides_applied"] = {
        "count": len(applied),
        "at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "entries": [
            {"table": e.get("table"), "action": e.get("action", "set"),
             "match": e.get("match"), "note": e.get("note")}
            for e in applied
        ],
    }
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[3])
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would change without writing data.json")
    args = ap.parse_args()

    overrides = load_overrides()
    if not overrides:
        print(f"No overrides in {OVERRIDES_JSON.name}; nothing to do.")
        return 0

    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    for line in apply_overrides(payload, overrides):
        print(f"  {line}")

    if args.dry_run:
        print("Dry run - data.json not written.")
        return 0

    with DATA_JSON.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, default=str)
    print(f"Wrote {DATA_JSON.name} with {payload['overrides_applied']['count']} "
          f"override(s) applied.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
