"""
load_cds.py
-----------
Common Data Set (CDS) patcher. Pulls dbo.cds_documents + dbo.cds_facts
(long/EAV extraction of each university's CDS PDF, one row per document x
field), maps each document's university to a dashboard market through
dbo.IPEDS_CH_Crosswalk -> dbo.Schools, and writes:

  assets/cds/<market_key>.json   one file per market that has CDS data:
                                 {market_key, schools:[{university, ipeds_id,
                                 school_key, years, documents[], fields[]}]}
  data.json tables.cds_index     one row per (market, school) with the years
                                 on file - the market page shows the Common
                                 Data Set tab only for markets in this index.

The per-market split keeps data.json small (Cloudflare 25 MiB asset cap) and
mirrors the ipeds_basic pattern: market.js fetches the asset on first visit
to the tab. export-data.py imports export_cds() so the Monday refresh keeps
the files current; run this script by hand to refresh CDS alone (~10s).

Run:
    python load_cds.py             # Azure AD interactive (default)
    python load_cds.py --auth sql  # SQL login (getpass)
    python load_cds.py --auth env  # SQLUSER/SQLPASSWORD env vars

Requires: ODBC Driver 18 for SQL Server, pyodbc.
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

HERE = Path(__file__).parent
DATA_JSON = HERE / "data.json"
CDS_DIR = HERE / "assets" / "cds"

SERVER = "subtextresearch.database.windows.net"
DATABASE = "StudentResearch"

# Documents -> market. ipeds_id is varchar in cds_documents; the crosswalk
# carries IPEDs as int. A school tracked in two markets gets the CDS on both.
DOCS_SQL = """
    SELECT
        d.doc_id,
        d.university,
        TRY_CAST(d.ipeds_id AS INT)        AS ipeds_id,
        d.cds_year,
        d.era,
        d.file_name,
        d.supplements,
        d.page_count,
        d.sections_present,
        d.source_url,
        s.SchoolKey                        AS school_key,
        s.MarketKey                        AS market_key,
        s.name                             AS school_name
    FROM dbo.cds_documents d
    LEFT JOIN dbo.IPEDS_CH_Crosswalk cx
           ON cx.IPEDs = TRY_CAST(d.ipeds_id AS INT)
    LEFT JOIN dbo.Schools s
           ON s.SchoolKey = cx.[Key]
          AND s.MarketKey = cx.marketKey
    ORDER BY d.university, d.cds_year
"""

FACTS_SQL = """
    SELECT doc_id, field, value, value_text, unit, cds_item,
           source_mode, confidence, notes
    FROM dbo.cds_facts
    ORDER BY doc_id, cds_item, field
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


def _num(value):
    if value is None:
        return None
    if isinstance(value, decimal.Decimal):
        f = float(value)
        return int(f) if f.is_integer() else round(f, 4)
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    return value


def _rows(cur, sql: str) -> list[dict]:
    cur.execute(sql)
    cols = [c[0] for c in cur.description]
    return [{c: _num(v) for c, v in zip(cols, row)} for row in cur.fetchall()]


def build_cds(cur) -> tuple[dict[int, dict], list[dict]]:
    """Return ({market_key: asset payload}, cds_index rows)."""
    docs = _rows(cur, DOCS_SQL)
    facts = _rows(cur, FACTS_SQL)

    facts_by_doc: dict[str, list[dict]] = {}
    for f in facts:
        facts_by_doc.setdefault(f["doc_id"], []).append(f)

    # Group documents by (market, ipeds_id) -> one school block per market.
    schools: dict[tuple[int, int], dict] = {}
    unmapped: set[str] = set()
    for d in docs:
        mk = d["market_key"]
        if mk is None:
            unmapped.add(d["university"])
            continue
        key = (mk, d["ipeds_id"])
        blk = schools.setdefault(key, {
            "university": d["university"],
            "school_name": d["school_name"],
            "ipeds_id": d["ipeds_id"],
            "school_key": d["school_key"],
            "years": [],
            "documents": [],
            "_facts": {},          # field -> meta + per-year values
        })
        blk["years"].append(d["cds_year"])
        blk["documents"].append({
            "cds_year": d["cds_year"],
            "era": d["era"],
            "file_name": d["file_name"],
            "supplements": d["supplements"],
            "page_count": d["page_count"],
            "sections_present": d["sections_present"],
            "source_url": d["source_url"],
        })
        for f in facts_by_doc.get(d["doc_id"], []):
            meta = blk["_facts"].setdefault(f["field"], {
                "field": f["field"],
                "cds_item": f["cds_item"],
                "unit": f["unit"],
                "values": {},
            })
            # Confidence 'NULL' + source_mode 'none' = item absent from that
            # edition; keep the row so the UI can explain the gap via notes.
            cell = {"v": f["value"], "t": f["value_text"], "c": f["confidence"]}
            if f["notes"]:
                cell["n"] = f["notes"]
            if f["source_mode"] and f["source_mode"] != "table":
                cell["m"] = f["source_mode"]
            meta["values"][d["cds_year"]] = cell

    by_market: dict[int, dict] = {}
    index: list[dict] = []
    for (mk, _ipeds), blk in sorted(schools.items(), key=lambda kv: (kv[0][0], kv[1]["university"])):
        blk["years"] = sorted(set(blk["years"]))
        blk["documents"].sort(key=lambda r: r["cds_year"])
        fields = sorted(blk.pop("_facts").values(), key=lambda r: (r["cds_item"] or "", r["field"]))
        blk["fields"] = fields
        populated = sum(
            1 for fl in fields for cell in fl["values"].values()
            if cell["v"] is not None or cell["t"] is not None
        )
        by_market.setdefault(mk, {"market_key": mk, "schools": []})["schools"].append(blk)
        index.append({
            "market_key": mk,
            "school_key": blk["school_key"],
            "ipeds_id": blk["ipeds_id"],
            "university": blk["university"],
            "years": blk["years"],
            "latest_year": blk["years"][-1] if blk["years"] else None,
            "doc_count": len(blk["documents"]),
            "field_count": len(fields),
            "populated": populated,
        })

    if unmapped:
        print(f"  cds: {len(unmapped)} university(ies) with no market via IPEDS_CH_Crosswalk, skipped: "
              + "; ".join(sorted(unmapped)))
    return by_market, index


def write_assets(by_market: dict[int, dict], cds_dir: Path = CDS_DIR) -> None:
    cds_dir.mkdir(parents=True, exist_ok=True)
    for old in cds_dir.glob("*.json"):
        old.unlink()
    for mk, payload in by_market.items():
        (cds_dir / f"{mk}.json").write_text(
            json.dumps(payload, separators=(",", ":"), default=str), encoding="utf-8",
        )


def export_cds(cur, cds_dir: Path = CDS_DIR) -> list[dict]:
    """export-data.py entry point: write the per-market assets, return cds_index rows."""
    by_market, index = build_cds(cur)
    write_assets(by_market, cds_dir)
    print(f"  cds: {len(index)} school(s) across {len(by_market)} market(s) -> {cds_dir}/")
    return index


def main() -> int:
    parser = argparse.ArgumentParser(description="Refresh Common Data Set assets + cds_index from Azure SQL.")
    parser.add_argument("--auth", choices=["aad", "integrated", "sql", "env"], default="aad")
    args = parser.parse_args()

    cn = connect(args.auth)
    cur = cn.cursor()
    index = export_cds(cur)
    for r in index:
        print(f"    market {r['market_key']}: {r['university']} (IPEDS {r['ipeds_id']}) "
              f"{r['years'][0]}..{r['years'][-1]}, {r['doc_count']} docs, "
              f"{r['populated']}/{r['field_count'] * r['doc_count']} facts populated")

    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    payload["tables"]["cds_index"] = index
    # Compact separators, same as export-data.py (Cloudflare 25 MiB cap).
    DATA_JSON.write_text(
        json.dumps(payload, separators=(",", ":"), default=str), encoding="utf-8"
    )
    print(f"  data.json: tables.cds_index <- {len(index)} row(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
