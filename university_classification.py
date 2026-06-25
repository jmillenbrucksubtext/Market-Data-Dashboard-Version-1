"""
university_classification.py
----------------------------
Anchor-university classification for the "Power 4 or R1 University?" qualifier.

Two inputs:

  POWER4_ANCHORS  - read live from dashboard.js (the single source of truth,
                    also used by the national-map P4 filter and
                    shadow_market/build_configs.py). 65 anchors, 2024-25
                    conference alignment.

  R1_ANCHORS      - Carnegie 2025 "Research 1" (very-high-research doctoral)
                    institutions, name-matched to this dataset's
                    scorecard.anchor_university strings. Membership is matched
                    on the EXACT anchor string the dashboard already uses, so
                    there is no fuzzy name-matching to go wrong.

The qualifier passes when an anchor is Power 4 OR R1. classify_anchor() returns
the basis so the scorecard explanation can say which one(s) applied.

Borderline / judgment calls (the 2025 Carnegie reclassification moved many
schools; these are the ones most worth a second look - flip membership below
to adjust):
  - Branch/regional campuses are classified on their own campus, NOT their
    flagship: "The Ohio State University at Mansfield" and "Rutgers University
    Newark" are treated as NOT R1 (regional/R2), even though their parent
    systems are R1.
  - Held OUT as R2 (not R1): East Carolina, Kennesaw State, Miami University
    (OH), Boise State, University of Idaho, University of Montana, Cleveland
    State, University of Akron, Wright State, UNC Greensboro, UT Rio Grande
    Valley, University of Missouri-St. Louis.

City-only "anchors" (e.g. "Mesa, AZ") are shadow/secondary markets with no
anchor university; the qualifier returns N/A for them rather than a fail.
"""

from __future__ import annotations

import re
from pathlib import Path

HERE = Path(__file__).parent
DASHBOARD_PATH = HERE / "dashboard.js"

# Matches a city-market anchor like "Mesa, AZ" / "Key West, FL" - a place name
# followed by a two-letter state code, i.e. a market with no anchor university.
_CITY_MARKET_RE = re.compile(r",\s*[A-Z]{2}$")


def load_power4_anchors() -> set[str]:
    """Parse POWER4_ANCHORS out of dashboard.js so the Python side stays in
    sync with the front-end's single source of truth (same approach as
    shadow_market/build_configs.py)."""
    source = DASHBOARD_PATH.read_text(encoding="utf-8")
    match = re.search(
        r"const POWER4_ANCHORS = new Set\(\[(.*?)\]\);",
        source,
        re.DOTALL,
    )
    if not match:
        raise RuntimeError("Could not locate POWER4_ANCHORS in dashboard.js")
    return set(re.findall(r'"([^"]+)"', match.group(1)))


# Carnegie 2025 R1 institutions present in this dataset, keyed on the exact
# scorecard.anchor_university string. Includes Power 4 schools that are also R1
# (most are) so the classification is self-consistent if read on its own.
R1_ANCHORS: set[str] = {
    "Arizona State University",
    "Auburn University",
    "Baylor University",
    "Binghamton University",
    "Brandeis University",
    "Brigham Young University",
    "California Institute of Technology",
    "Clemson University",
    "College of William and Mary",
    "Colorado State University",
    "Cornell University",
    "Dartmouth College",
    "Duke University",
    "Florida Atlantic University",
    "Florida International University",
    "Florida State University",
    "George Mason University",
    "George Washington University",
    "Georgia Institute of Technology",
    "Indiana University Bloomington",
    "Indiana University-Purdue University Indianapolis",
    "Iowa State University",
    "Johns Hopkins University",
    "Kansas State University",
    "Kent State University",
    "Lehigh University",
    "Louisiana State University",
    "Michigan State University",
    "Mississippi State University",
    "Montana State University",
    "New Mexico State University",
    "New York University",
    "North Carolina State University",
    "North Dakota State University",
    "Northeastern University",
    "Northern Arizona University",
    "Northwestern University",
    "Ohio State University",
    "Ohio University",
    "Oklahoma State University",
    "Old Dominion University",
    "Oregon State University",
    "Penn State",
    "Portland State University",
    "Purdue University",
    "Rensselaer Polytechnic Institute",
    "Rochester Institute of Technology",
    "Rutgers University",
    "Southern Methodist University",
    "Stanford University",
    "Syracuse University",
    "Temple University",
    "Texas A&M University",
    "Texas State University",
    "Texas Tech University",
    "The University of Alabama in Huntsville",
    "Tufts University",
    "Tulane University",
    "University at Albany SUNY",
    "University at Buffalo SUNY",
    "University of Alabama",
    "University of Alabama at Birmingham",
    "University of Arizona",
    "University of Arkansas",
    "University of California Berkeley",
    "University of California Davis",
    "University of California Irvine",
    "University of California Merced",
    "University of California Riverside",
    "University of California San Diego",
    "University of California Santa Barbara",
    "University of Central Florida",
    "University of Cincinnati",
    "University of Colorado Boulder",
    "University of Colorado Denver",
    "University of Connecticut",
    "University of Delaware",
    "University of Florida",
    "University of Georgia",
    "University of Hawaii at Manoa",
    "University of Houston",
    "University of Illinois at Chicago",
    "University of Illinois at Urbana-Champaign",
    "University of Iowa",
    "University of Kansas",
    "University of Kentucky",
    "University of Louisiana at LaFayette",
    "University of Louisville",
    "University of Maine",
    "University of Maryland College Park",
    "University of Massachusetts Amherst",
    "University of Massachusetts Lowell",
    "University of Memphis",
    "University of Michigan",
    "University of Minnesota Twin Cities",
    "University of Mississippi",
    "University of Missouri",
    "University of Nebraska Lincoln",
    "University of Nevada Las Vegas",
    "University of Nevada Reno",
    "University of New Hampshire",
    "University of New Mexico",
    "University of North Carolina at Chapel Hill",
    "University of North Carolina at Charlotte",
    "University of North Dakota",
    "University of North Texas",
    "University of Notre Dame",
    "University of Oklahoma",
    "University of Oregon",
    "University of Pittsburgh",
    "University of South Carolina",
    "University of South Florida",
    "University of Southern California",
    "University of Southern Mississippi",
    "University of Tennessee",
    "University of Texas at Arlington",
    "University of Texas at Austin",
    "University of Texas at Dallas",
    "University of Texas at San Antonio",
    "University of Toledo",
    "University of Utah",
    "University of Vermont",
    "University of Virginia",
    "University of Washington",
    "University of Wisconsin Madison",
    "University of Wisconsin Milwaukee",
    "University of Wyoming",
    "Utah State University",
    "Vanderbilt University",
    "Virginia Commonwealth University",
    "Virginia Polytechnic Institute and State University",
    "Wake Forest University",
    "Washington State University",
    "West Virginia University",
    "Western Michigan University",
    "Wichita State University",
    "Yale University",
}


def is_city_market(anchor: str | None) -> bool:
    """True when the anchor is a city/place label (no anchor university)."""
    return bool(anchor) and bool(_CITY_MARKET_RE.search(anchor))


def classify_anchor(anchor: str | None, power4: set[str] | None = None) -> dict:
    """Classify a single anchor_university string.

    Returns {"power4": bool, "r1": bool, "is_city": bool}. Pass `power4` in to
    avoid re-reading dashboard.js per call.
    """
    if power4 is None:
        power4 = load_power4_anchors()
    name = (anchor or "").strip()
    return {
        "power4": name in power4,
        "r1": name in R1_ANCHORS,
        "is_city": is_city_market(name),
    }


# ------------------------------------------------------------------
# Qualifier-result builders
# ------------------------------------------------------------------
# Shared by export-data.py (full SQL pipeline) and load_university_qualifiers.py
# (standalone data.json patcher) so the two new qualifiers are produced
# identically no matter which path runs. Result shape matches the other
# qualifier evaluators: id / label / threshold_display / actual_display /
# actual / status / tier / explanation.

POWER4_R1_QID = "power4_r1"
POWER4_R1_LABEL = "Power 4 or R1 university"
POWER4_R1_THRESHOLD = "Power 4 or R1"

FWD_TOP50_QID = "fwd_top50"
FWD_TOP50_LABEL = "Subtext Top 50 forward-ranking market"
FWD_TOP50_THRESHOLD = "Top 50"


def power4_r1_result(anchor: str | None, power4: set[str] | None = None) -> dict:
    """Build the 'Power 4 or R1 university' qualifier result for one anchor."""
    base = {
        "id": POWER4_R1_QID,
        "label": POWER4_R1_LABEL,
        "threshold_display": POWER4_R1_THRESHOLD,
    }
    cls = classify_anchor(anchor, power4)
    if cls["is_city"] or not (anchor or "").strip():
        return {
            **base,
            "actual_display": "-", "actual": None,
            "status": "na", "tier": "na",
            "explanation": "no anchor university (city market)",
        }
    name = anchor.strip()
    if cls["power4"] and cls["r1"]:
        disp = "Power 4 + R1"
        expl = f"{name} is a Power 4 conference member and Carnegie 2025 R1"
    elif cls["power4"]:
        disp = "Power 4"
        expl = f"{name} is a Power 4 conference member"
    elif cls["r1"]:
        disp = "R1"
        expl = f"{name} is a Carnegie 2025 R1 (very-high-research) university"
    else:
        disp = "Neither"
        expl = f"{name} is not Power 4 or Carnegie 2025 R1"
    passed = bool(cls["power4"] or cls["r1"])
    status = "pass" if passed else "fail"
    return {
        **base,
        "actual_display": disp,
        "actual": passed,
        "status": status,
        "tier": status,
        "explanation": expl,
    }


def forward_top50_result(fwd_rank) -> dict:
    """Build the 'Subtext Top 50 forward-ranking market' qualifier result.

    Passes when the market's forward-model list rank is in the top 50. Markets
    absent from the forward-model screener (fwd_rank is None) are N/A.
    """
    base = {
        "id": FWD_TOP50_QID,
        "label": FWD_TOP50_LABEL,
        "threshold_display": FWD_TOP50_THRESHOLD,
    }
    if fwd_rank is None:
        return {
            **base,
            "actual_display": "-", "actual": None,
            "status": "na", "tier": "na",
            "explanation": "not ranked in the forward model",
        }
    rank = int(fwd_rank)
    passed = rank <= 50
    status = "pass" if passed else "fail"
    return {
        **base,
        "actual_display": f"#{rank}",
        "actual": rank,
        "status": status,
        "tier": status,
        "explanation": (
            f"forward-model list rank #{rank}"
            + ("" if passed else " (outside top 50)")
        ),
    }
