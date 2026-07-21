"""
load_dispatch.py
----------------
Fetches https://subtext-dispatch.jacksubtextuse.workers.dev/ and extracts
the article headlines (h2 = main features, h3 = briefs) so the dashboard
can scroll them in a news-ticker bar at the top of the Industry view.

Designed to be either:
  - imported by export-data.py during the weekly refresh
  - run standalone to patch dispatch_headlines into data.json without a
    full SQL refresh (matches the load_*.py qualifier-patcher pattern)

Usage (standalone):
    python load_dispatch.py
"""

from __future__ import annotations

import datetime as dt
import html
import json
import re
import sys
import urllib.request
from pathlib import Path

DISPATCH_URL = "https://subtext-dispatch.jacksubtextuse.workers.dev/"
DATA_JSON    = Path(__file__).parent / "data.json"
USER_AGENT   = "subtext-dashboard-refresher/1.0"
TIMEOUT_SEC  = 20


def _strip_tags(s: str) -> str:
    """Drop inline tags and collapse whitespace inside a headline."""
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    s = s.replace("—", "-")  # house style: no em dashes in UI text
    return re.sub(r"\s+", " ", s).strip()


def fetch_dispatch_headlines(url: str = DISPATCH_URL) -> dict:
    """Return {url, issue, fetched_at, features[], briefs[]} from the dispatch.

    Features are the h2 headlines; briefs are the h3s. Both are HTML-decoded
    and tag-stripped. Raises on network/HTTP failure so callers can decide
    whether to skip or propagate.
    """
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as r:
        if r.status != 200:
            raise RuntimeError(f"dispatch returned HTTP {r.status}")
        body = r.read().decode("utf-8", errors="replace")

    # Title looks like "The Subtext Dispatch - May 18, 2026"; pull the date
    # half if present so the dashboard can show an issue label.
    issue = ""
    m = re.search(r"<title[^>]*>\s*([^<]+?)\s*</title>", body, re.I)
    if m:
        t = _strip_tags(m.group(1))
        # Keep only the part after the em dash if there is one.
        for sep in (" - ", " – ", " - "):
            if sep in t:
                issue = t.split(sep, 1)[1].strip()
                break
        if not issue:
            issue = t

    features = [_strip_tags(m) for m in re.findall(r"<h2\b[^>]*>(.*?)</h2>", body, re.S | re.I)]
    briefs   = [_strip_tags(m) for m in re.findall(r"<h3\b[^>]*>(.*?)</h3>", body, re.S | re.I)]

    # Drop the masthead "The Subtext Dispatch" if it shows up as an h2.
    features = [t for t in features if t and t.lower() != "the subtext dispatch"]

    return {
        "url":         url,
        "issue":       issue,
        "fetched_at":  dt.datetime.now(dt.timezone.utc).isoformat(),
        "features":    features,
        "briefs":      briefs,
    }


def patch_data_json(data_path: Path = DATA_JSON) -> dict:
    """Standalone-run entry: refresh dispatch_headlines in data.json."""
    if not data_path.exists():
        sys.exit(f"data.json not found at {data_path}")
    payload = json.loads(data_path.read_text(encoding="utf-8"))
    headlines = fetch_dispatch_headlines()
    payload["dispatch_headlines"] = headlines
    data_path.write_text(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"  dispatch_headlines: {len(headlines['features'])} features + "
          f"{len(headlines['briefs'])} briefs  [{headlines['issue']}]")
    return headlines


if __name__ == "__main__":
    patch_data_json()
