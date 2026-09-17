/* schedule-resolver.js
   ---------------------
   Shared resolver for tables.market_analysis_schedule (the team's Market
   Analysis Schedule workbook, read by export-data.py each weekly refresh or
   load_market_schedule.py standalone).

   Market names on the sheet are informal ("TCU", "Ole Miss", "Kansas
   (Lawrence) - High level update"), so each row is matched to a tracked
   university at runtime: exact name -> alias -> "University of X" /
   "X University" expansions, after stripping parentheticals and trailing
   "- note" segments.

   Used by two pages, which is why it lives here rather than in either:
     - dashboard.js  : Industry page > Analysis Schedule tab (links rows to
                       market pages)
     - market.js     : market page topbar "Last analyzed" widget (lists every
                       analysis of the current market)

   Because both read the same data.json table, refreshing the schedule
   (load_market_schedule.py or the Monday export) updates both views with
   no further step. New sheet shorthand that fails to match -> add an alias
   to ALIASES below.

   Exposes window.SubtextSchedule = { ALIASES, norm, buildIndex, resolve,
   href, fmtDate, dateValue, rows, forMarket }. */
(function () {
  "use strict";

  // Informal schedule name -> exact university_name in campus_locations.
  // Keys are norm()-normalised. Values that drift out of the data just
  // leave the row unlinked - nothing breaks.
  var ALIASES = {
    "ann arbor":            "University of Michigan",
    "app state":            "Appalachian State University",
    "boulder":              "University of Colorado Boulder",
    "cal poly":             "California Polytechnic State University Pomona", // only Cal-Poly row on the sheet is Pomona
    "cal riverside":        "University of California Riverside",
    "cal state fullerton":  "California State University Fullerton",
    "cincinatti":           "University of Cincinnati", // sheet misspelling
    "colorado":             "University of Colorado Boulder",
    "fau":                  "Florida Atlantic University",
    "fiu":                  "Florida International University",
    "georgia tech":         "Georgia Institute of Technology",
    "illinois":             "University of Illinois at Urbana-Champaign",
    "indiana":              "Indiana University Bloomington",
    "indiana university":   "Indiana University Bloomington",
    "kennesaw":             "Kennesaw State University",
    "kennessaw":            "Kennesaw State University", // sheet misspelling
    "kennessaw state":      "Kennesaw State University",
    "knoxville":            "University of Tennessee",
    "lsu":                  "Louisiana State University",
    "maryland":             "University of Maryland College Park",
    "maryland college park": "University of Maryland College Park",
    "minnesota":            "University of Minnesota Twin Cities",
    "university of minnesota": "University of Minnesota Twin Cities",
    "mizzou":               "University of Missouri",
    "nau":                  "Northern Arizona University",
    "nau flagstaff":        "Northern Arizona University",
    "nebraska":             "University of Nebraska Lincoln",
    "nw arkansas":          "University of Arkansas",
    "ole miss":             "University of Mississippi",
    "ou":                   "University of Oklahoma",
    "sdsu":                 "San Diego State University",
    "tcu":                  "Texas Christian University",
    "texas":                "University of Texas at Austin",
    "uab":                  "University of Alabama at Birmingham",
    "uc berkeley":          "University of California Berkeley",
    "uc berkely":           "University of California Berkeley", // sheet misspelling
    "uc davis":             "University of California Davis",
    "uc irvine":            "University of California Irvine",
    "uc riverside":         "University of California Riverside",
    "uc san diego":         "University of California San Diego",
    "ucla":                 "University of California Los Angeles",
    "ucsd":                 "University of California San Diego",
    "uconn":                "University of Connecticut",
    "umass":                "University of Massachusetts Amherst",
    "umass amherst":        "University of Massachusetts Amherst",
    "umass amerhurst":      "University of Massachusetts Amherst", // sheet misspelling
    "unc":                  "University of North Carolina at Chapel Hill",
    "unc chapel hill":      "University of North Carolina at Chapel Hill",
    "unc charlotte":        "University of North Carolina at Charlotte",
    "usf":                  "University of South Florida",
    "uw seattle":           "University of Washington",
    "washington":           "University of Washington",
    "washington seattle":   "University of Washington",
    "vcu":                  "Virginia Commonwealth University",
    "virginia commonwealtrh university": "Virginia Commonwealth University", // sheet misspelling
    "virginia tech":        "Virginia Polytechnic Institute and State University",
    "west lafayette":       "Purdue University",
    "wisconsin":            "University of Wisconsin Madison",
  };

  var INDEX = null; // norm(university_name) -> {market_key, school_key, name, isAnchor}

  function norm(s) {
    return String(s).toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\b(?:the|at)\b/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  /* Build the university index straight from data.json (scorecard for the
     anchor per market, campus_locations for every school). Anchors are
     indexed first so a normalisation collision resolves to the anchor. */
  function buildIndex(DATA) {
    INDEX = new Map();
    var anchorByMarket = new Map();
    (DATA.tables.scorecard || []).forEach(function (r) {
      anchorByMarket.set(r.market_key, r.anchor_university);
    });
    var campuses = DATA.tables.campus_locations || [];
    ["anchor", "other"].forEach(function (pass) {
      campuses.forEach(function (c) {
        var isAnchor = c.university_name === anchorByMarket.get(c.market_key);
        if ((pass === "anchor") !== isAnchor) return;
        var key = norm(c.university_name);
        if (key && !INDEX.has(key)) {
          INDEX.set(key, { market_key: c.market_key, school_key: c.school_key, name: c.university_name, isAnchor: isAnchor });
        }
      });
    });
    return INDEX;
  }

  var NOISE = { update: 1, updated: 1, email: 1, market: 1, high: 1, level: 1, only: 1, summary: 1, prelease: 1, refresh: 1 };

  function resolve(raw) {
    if (!raw || !INDEX) return null;
    var rawNorm = norm(raw);
    // Submarket rows ("Belmont - Charlotte Submarket") share names with
    // unrelated universities - never link them.
    if (!rawNorm || rawNorm.indexOf("submarket") !== -1) return null;

    var variants = [];
    var push = function (s) {
      var n = typeof s === "string" ? norm(s) : "";
      if (n && variants.indexOf(n) === -1) variants.push(n);
    };
    push(raw);
    var noParens = String(raw).replace(/\([^)]*\)/g, " ");
    push(noParens);
    // Progressively drop trailing "- note" segments ("Georgia Tech - Email Update").
    var segs = noParens.split(/\s+-\s+/);
    for (var i = segs.length - 1; i >= 1; i--) push(segs.slice(0, i).join(" "));
    // Drop trailing update-noise words ("USF Update").
    var toks = norm(noParens).split(" ");
    while (toks.length > 1 && NOISE[toks[toks.length - 1]]) {
      toks.pop();
      push(toks.join(" "));
    }

    for (var j = 0; j < variants.length; j++) {
      var v = variants[j];
      var alias = ALIASES[v];
      // "U Michigan" / "U of Michigan" style shorthand -> "University of Michigan".
      var uOf = /^u (?:of )?(.+)$/.exec(v);
      var hit = INDEX.get(v)
        || (alias && INDEX.get(norm(alias)))
        || INDEX.get("university of " + v)
        || INDEX.get(v + " university")
        || (uOf && INDEX.get("university of " + uOf[1]));
      if (hit) return hit;
    }
    return null;
  }

  // Anchor school -> market page; any other school -> its University tab
  // (market.js reads ?school= and #university), same as the search suggest.
  function href(m) {
    return m.isAnchor
      ? "market.html?id=" + m.market_key
      : "market.html?id=" + m.market_key + "&school=" + m.school_key + "#university";
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /* Sheet dates are usually ISO (real date cells) but the sheet also holds
     text like "Thursday, April 2, 2027" or "9/19/2025*". Return a timestamp
     (local midnight) or null. */
  function dateValue(d) {
    if (!d) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    var t = Date.parse(String(d).replace(/\*/g, "").trim());
    return isNaN(t) ? null : t;
  }

  function fmtDate(d) {
    if (!d) return "";
    var t = dateValue(d);
    if (t == null) return String(d);
    var dt = new Date(t);
    return MONTHS[dt.getMonth()] + " " + dt.getDate() + ", " + dt.getFullYear();
  }

  function rows(DATA) {
    return (DATA.tables.market_analysis_schedule || []).filter(function (r) { return r.market_name; });
  }

  /* Every schedule row that resolves to this market, newest presentation
     date first (undated rows last). Each item carries the resolved school
     so multi-university markets can say which school a row was about. */
  function forMarket(DATA, marketKey) {
    if (!INDEX) buildIndex(DATA);
    var out = [];
    rows(DATA).forEach(function (r) {
      var m = resolve(r.market_name);
      if (m && m.market_key === marketKey) out.push({ row: r, school: m, when: dateValue(r.initial_analysis_date) });
    });
    out.sort(function (a, b) {
      if (a.when == null && b.when == null) return 0;
      if (a.when == null) return 1;
      if (b.when == null) return -1;
      return b.when - a.when;
    });
    return out;
  }

  window.SubtextSchedule = {
    ALIASES: ALIASES, norm: norm, buildIndex: buildIndex, resolve: resolve,
    href: href, fmtDate: fmtDate, dateValue: dateValue, rows: rows, forMarket: forMarket,
  };
})();
