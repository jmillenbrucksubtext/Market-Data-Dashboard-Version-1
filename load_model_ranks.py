"""
load_model_ranks.py
-------------------
Standalone data.json patcher (see the load_*.py family): re-stamps
scorecard.fwd_rank and scorecard.acq_rank from forward-model.html and
acquisitions-model.html without a full SQL refresh. Run it whenever the
data-science team drops an updated model HTML between weekly refreshes:

    python load_model_ranks.py

Because fwd_rank feeds the fwd_top50 qualifier, the qualifier pass is
re-run afterwards (same code path as load_university_qualifiers.py) so
the scorecard badge stays consistent with the new ranks.
"""

from __future__ import annotations

import json
from pathlib import Path

from load_university_qualifiers import patch_university_qualifiers
from model_ranks import ACQUISITIONS_HTML, FORWARD_HTML, compute_model_ranks

DATA_JSON = Path(__file__).resolve().parent / "data.json"


def patch_model_ranks(payload: dict) -> dict:
    scorecard = payload["tables"]["scorecard"]
    fwd_ranks = compute_model_ranks(scorecard, FORWARD_HTML)
    acq_ranks = compute_model_ranks(scorecard, ACQUISITIONS_HTML)
    for r in scorecard:
        r["fwd_rank"] = fwd_ranks.get(r["market_key"])  # None if not in the screener
        r["acq_rank"] = acq_ranks.get(r["market_key"])
    return {"fwd": len(fwd_ranks), "acq": len(acq_ranks)}


def main() -> int:
    payload = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    counts = patch_model_ranks(payload)
    qual_counts = patch_university_qualifiers(payload)
    # Compact separators to match export-data.py - indent=2 pushes data.json
    # past Cloudflare's 25 MiB limit and breaks the live site.
    DATA_JSON.write_text(
        json.dumps(payload, separators=(",", ":"), default=str),
        encoding="utf-8",
    )
    print(
        f"  fwd_rank: {counts['fwd']} markets ranked",
        f"  acq_rank: {counts['acq']} markets ranked",
        f"  fwd_top50 qualifier refreshed: {qual_counts['fwd_top50_pass']} passing",
        sep="\n",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
