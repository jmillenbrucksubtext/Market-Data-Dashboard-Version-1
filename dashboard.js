/* =============================================================
   Subtext Living - Market Data Dashboard (client)
   Reads data.json (produced by export-data.py) and renders the
   College-House-style market dashboard.
   ============================================================= */

const NUM_FMT_INT = new Intl.NumberFormat("en-US");
const NUM_FMT_USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

// Subtext masterbrand palette (see Subtext Brand Colors.pdf)
const C = {
  slate:     "#2b2825",
  slate70:   "#5a544f",
  slate50:   "#837c75",
  slate30:   "#b6b1ab",
  slate15:   "#d8d4ce",
  everest:   "#16352e",
  birch:     "#a95818",
  brown:     "#512213",
  beige:     "#f7f1e3",
  beigeDeep: "#ede5cf",
  lime:      "#c1d100",
  limeSoft:  "#e6ee99",
  warn:      "#c79830",
  good:      "#16352e",  // everest green for positive
  bad:       "#a95818",  // birch for negative
};

// Chart.js global defaults
if (typeof Chart !== "undefined") {
  Chart.defaults.font.family =
    '"Pragmatica", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.color = C.slate70;
  Chart.defaults.borderColor = C.beigeDeep;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 8;
  Chart.defaults.plugins.tooltip.backgroundColor = C.slate;
  Chart.defaults.plugins.tooltip.titleColor = C.beige;
  Chart.defaults.plugins.tooltip.bodyColor = C.beige;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 4;
  Chart.defaults.plugins.tooltip.titleFont = { weight: "700", size: 12 };
}

// Power 4 anchor universities (2024-25 conference alignment). Match against
// scorecard.anchor_university (exact string). UCLA, Boston College, and
// Miami (FL) are P4 schools that aren't currently tracked as anchor markets
// in this dataset, so they're omitted.
const POWER4_ANCHORS = new Set([
  // SEC
  "University of Alabama", "University of Arkansas", "Auburn University",
  "University of Florida", "University of Georgia", "University of Kentucky",
  "Louisiana State University", "Mississippi State University",
  "University of Mississippi", "University of Missouri", "University of Oklahoma",
  "University of South Carolina", "University of Tennessee",
  "Texas A&M University", "University of Texas at Austin", "Vanderbilt University",
  // Big Ten
  "University of Illinois at Urbana-Champaign", "Indiana University Bloomington",
  "University of Iowa", "University of Maryland College Park",
  "University of Michigan", "Michigan State University",
  "University of Minnesota Twin Cities", "University of Nebraska Lincoln",
  "Northwestern University", "Ohio State University", "University of Oregon",
  "Penn State", "Purdue University", "Rutgers University",
  "University of Southern California", "University of Washington",
  "University of Wisconsin Madison",
  // Big 12
  "University of Arizona", "Arizona State University", "Baylor University",
  "Brigham Young University", "University of Cincinnati",
  "University of Colorado Boulder", "University of Houston",
  "Iowa State University", "University of Kansas", "Kansas State University",
  "Oklahoma State University", "Texas Christian University",
  "Texas Tech University", "University of Central Florida",
  "University of Utah", "West Virginia University",
  // ACC
  "University of California Berkeley", "Clemson University", "Duke University",
  "Florida State University", "Georgia Institute of Technology",
  "University of Louisville", "North Carolina State University",
  "University of North Carolina at Chapel Hill", "University of Notre Dame",
  "University of Pittsburgh", "Southern Methodist University",
  "Stanford University", "Syracuse University", "University of Virginia",
  "Virginia Polytechnic Institute and State University", "Wake Forest University",
]);

let DATA = null;
let LABELS = new Map(); // market_key → {anchor_university, city, state_abbr, is_subtext30}
let ANCHOR_COORDS = new Map(); // market_key → {lat, lng}
let MARKET_UNIS = new Map(); // market_key → [{school_key, name, enrollment}] anchor first, then by size
let activeMarketKey = null;
// Default sort: best qualifier score on top. NA scores fall to the bottom
// of the desc sort because the comparator below pushes nulls last.
let sortState = { col: "qualifier_score", dir: "desc" };
let charts = {};

// National map state
let industryMap = null;
let industryMarkerLayer = null;

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const res = await fetch("data.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
  } catch (err) {
    document.body.innerHTML =
      `<div class="empty-state">Couldn't load data.json - ${err}</div>`;
    return;
  }

  // Build the market-label map once.
  for (const r of DATA.tables.scorecard) {
    LABELS.set(r.market_key, {
      anchor_university: r.anchor_university,
      city: r.city,
      state_abbr: r.state_abbr,
      is_subtext30: r.is_subtext30 === 1,
    });
  }

  // Build anchor-coordinate lookup: market_key → {lat, lng}.
  // Prefer the campus whose name matches the scorecard's anchor_university;
  // fall back to any campus in the market with coordinates.
  const campuses = DATA.tables.campus_locations || [];
  const byMarket = new Map();
  for (const c of campuses) {
    if (c.campus_lat == null || c.campus_lng == null) continue;
    if (!byMarket.has(c.market_key)) byMarket.set(c.market_key, []);
    byMarket.get(c.market_key).push(c);
  }
  for (const r of DATA.tables.scorecard) {
    const list = byMarket.get(r.market_key) || [];
    const anchor = list.find((c) => c.university_name === r.anchor_university) || list[0];
    if (anchor) ANCHOR_COORDS.set(r.market_key, { lat: anchor.campus_lat, lng: anchor.campus_lng });
  }

  // Every university in every market, anchor first - no school is hidden
  // behind the anchor. campus_locations can carry one row per school per
  // year, so dedupe by school_key.
  for (const c of campuses) {
    if (!MARKET_UNIS.has(c.market_key)) MARKET_UNIS.set(c.market_key, []);
    const list = MARKET_UNIS.get(c.market_key);
    if (!list.some((u) => u.school_key === c.school_key)) {
      list.push({
        school_key: c.school_key,
        name: c.university_name,
        enrollment: c.total_enrollment,
        lat: c.campus_lat,
        lng: c.campus_lng,
      });
    }
  }
  for (const [mk, list] of MARKET_UNIS) {
    const anchorName = LABELS.get(mk)?.anchor_university;
    list.sort((a, b) =>
      (b.name === anchorName ? 1 : 0) - (a.name === anchorName ? 1 : 0)
      || (b.enrollment || 0) - (a.enrollment || 0)
      || a.name.localeCompare(b.name));
  }

  setFreshness();
  buildMarketSearchIndex();
  bindMarketSearch();
  bindUI();
  bindNav();
  renderAll();
});

/* ----- View routing ------------------------------------------ */

const VALID_VIEWS = ["industry", "marketstate", "sources", "forward", "marketanalysis", "tools"];

function bindNav() {
  const items = document.querySelectorAll(".nav-item[data-view]");
  items.forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      showView(el.dataset.view);
    });
  });
  // initial view from URL hash
  const hash = (location.hash || "#industry").replace(/^#/, "");
  showView(VALID_VIEWS.includes(hash) ? hash : "industry");

  window.addEventListener("hashchange", () => {
    const h = location.hash.replace(/^#/, "");
    if (VALID_VIEWS.includes(h)) showView(h);
  });
}

function showView(name) {
  document.querySelectorAll(".view").forEach((v) => {
    v.classList.toggle("active", v.id === `${name}-view`);
  });
  document.querySelectorAll(".nav-item[data-view]").forEach((n) => {
    n.classList.toggle("active", n.dataset.view === name);
  });
  if (location.hash !== `#${name}`) {
    history.replaceState(null, "", `#${name}`);
  }
  // Ticker is Industry-only. Build lazily on first show.
  const ticker = document.getElementById("dispatch-ticker");
  if (ticker) {
    if (name === "industry") {
      buildDispatchTicker();
      ticker.hidden = !ticker.dataset.populated;
    } else {
      ticker.hidden = true;
    }
  }
  // scroll to top of content on view switch
  window.scrollTo({ top: 0, behavior: "instant" });
}

/* ----- Dispatch ticker --------------------------------------- */

function buildDispatchTicker() {
  const ticker = document.getElementById("dispatch-ticker");
  const track  = document.getElementById("dispatch-ticker-track");
  if (!ticker || !track || ticker.dataset.populated) return;

  const h = DATA && DATA.dispatch_headlines;
  if (!h || (!h.features?.length && !h.briefs?.length)) return;

  if (h.url) ticker.href = h.url;
  ticker.title = h.issue
    ? `The Subtext Dispatch - ${h.issue} (click to open)`
    : "The Subtext Dispatch (click to open)";

  // Features first, then briefs - same order as the dispatch page.
  // House style: no em dashes, even in fetched headline copy.
  const items = [...(h.features || []), ...(h.briefs || [])]
    .map((t) => String(t).replace(/—/g, "-"));

  // Build a single run, then duplicate it inside the track so the
  // CSS translateX(-50%) loop is seamless.
  const buildRun = () => {
    const frag = document.createDocumentFragment();
    items.forEach((title, i) => {
      const item = document.createElement("span");
      item.className = "dispatch-ticker-item";
      item.textContent = title;
      frag.appendChild(item);
      if (i < items.length - 1) {
        const sep = document.createElement("span");
        sep.className = "dispatch-ticker-sep";
        sep.textContent = "◆";
        frag.appendChild(sep);
      }
    });
    return frag;
  };

  track.appendChild(buildRun());
  // Spacer between the two copies so the join isn't an awkward double-headline.
  const tail = document.createElement("span");
  tail.className = "dispatch-ticker-sep";
  tail.textContent = "◆";
  tail.style.padding = "0 10px";
  track.appendChild(tail);
  track.appendChild(buildRun());

  ticker.dataset.populated = "1";
}

/* ----- Helpers ------------------------------------------------ */

function setFreshness() {
  const el = document.getElementById("data-as-of");
  if (!DATA.data_as_of) { el.textContent = "unknown"; return; }
  const d = new Date(DATA.data_as_of);
  el.textContent = d.toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });
}

function fmtPct(v, digits = 1) {
  if (v == null || isNaN(v)) return "-";
  return (v * 100).toFixed(digits) + "%";
}
function fmtInt(v) {
  if (v == null || isNaN(v)) return "-";
  return NUM_FMT_INT.format(Math.round(v));
}
function fmtUsd(v) {
  if (v == null || isNaN(v)) return "-";
  return NUM_FMT_USD.format(v);
}
function deltaSpan(v) {
  if (v == null) return `<span class="delta flat">-</span>`;
  const cls = v > 0.005 ? "up" : v < -0.005 ? "down" : "flat";
  const arr = v > 0.005 ? "▲" : v < -0.005 ? "▼" : "";
  return `<span class="delta ${cls}"><span class="arrow">${arr}</span>${fmtPct(v)}</span>`;
}

function qualifierPill(row) {
  if (row.qualifier_score == null) return `<span class="qual-mini qual-mini-na">-</span>`;
  const pct = Math.round(row.qualifier_score * 100);
  const tier = pct >= 80 ? "good" : pct >= 60 ? "warn" : "bad";
  const label = `${row.qualifier_passes}/${row.qualifier_evaluable}`;
  return `<span class="qual-mini qual-mini-${tier}" title="${label} of evaluable Subtext qualifiers passing">${pct}%</span>`;
}

// Qualifier score as a tier-coloured pill - same 80/60 thresholds as the
// market page badge and qualifierPill(), but keyed off the bare fraction so
// it can serve as a PIPELINE_COLS formatter.
function fmtQualScorePill(v) {
  const pct = Math.round(v * 100);
  const tier = pct >= 80 ? "good" : pct >= 60 ? "warn" : "bad";
  return `<span class="qual-mini qual-mini-${tier}">${pct}%</span>`;
}

// "Yes"/"No" designation cell: green check for yes, muted dash otherwise.
// The Excel export writes the raw "Yes"/"No" string instead.
function fmtYesFlag(v) {
  return v === "Yes"
    ? `<span class="flag-yes">✓</span>`
    : `<span class="muted">-</span>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function shortLabel(market_key) {
  const l = LABELS.get(market_key);
  if (!l) return `Market ${market_key}`;
  return l.anchor_university;
}

function fullLabel(market_key) {
  const l = LABELS.get(market_key);
  if (!l) return `Market ${market_key}`;
  return `${l.anchor_university} · ${l.city}, ${l.state_abbr}`;
}

/* ----- Visible rows ------------------------------------------ */

function visibleScorecardRows() {
  let rows = DATA.tables.scorecard.slice();
  const q = document.getElementById("market-filter").value.trim().toLowerCase();
  const scope = document.getElementById("market-scope")?.value || "all";

  if (q) {
    // A search reaches the entire tracked universe - the scope dropdown
    // (Active / Subtext-30 / Power 4 / All) is bypassed so any market can be
    // found, not just the ones currently filtered onto the map.
    rows = rows.filter((r) => marketMatchesQuery(r, q));
  } else if (scope === "subtext30") {
    rows = rows.filter((r) => r.is_subtext30 === 1);
  } else if (scope === "power4") {
    rows = rows.filter((r) => POWER4_ANCHORS.has(r.anchor_university));
  } else if (scope === "active") {
    rows = rows.filter((r) => r.market_status);
  }

  // Attach yoy_rent_growth from rent_yoy
  const yoyByKey = new Map(
    DATA.tables.rent_yoy.map((r) => [r.market_key, r.yoy_rent_growth]),
  );
  // Attach qualifier score (% passing of evaluable)
  const qualByKey = new Map(
    (DATA.tables.market_qualifiers || []).map((q) => [q.market_key, q]),
  );
  // Attach affluence (mean origin income) - null when sample is too small
  const AFF_MIN_N = 100;
  const affByKey = new Map(
    (DATA.tables.market_affluence || []).map((a) => [a.market_key, a]),
  );
  rows = rows.map((r) => {
    const q = qualByKey.get(r.market_key);
    const a = affByKey.get(r.market_key);
    const hasSample = a && a.n_students >= AFF_MIN_N;
    return {
      ...r,
      yoy_rent_growth: yoyByKey.get(r.market_key) ?? null,
      // Share of student demand not yet served by purpose-built beds (1 - penetration).
      // Negative for over-supplied markets (beds > FTE); sorts alongside penetration.
      uncaptured_demand: r.penetration_ratio != null ? 1 - r.penetration_ratio : null,
      qualifier_score: q && q.score_pct != null ? q.score_pct : null,
      qualifier_passes: q?.passes ?? null,
      qualifier_evaluable: q?.evaluable ?? null,
      mean_origin_income: hasSample ? a.mean_origin_income : null,
      pct_hiinc: hasSample ? a.pct_hiinc : null,
      affluence_n: a?.n_students ?? null,
    };
  });

  const { col, dir } = sortState;
  const sign = dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const av = a[col], bv = b[col];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number") return (av - bv) * sign;
    return String(av).localeCompare(String(bv)) * sign;
  });
  return rows;
}

/* ----- Scorecard Excel (.xlsx) export ------------------------- */

// Lazy-load ExcelJS (same CDN the app already uses for Chart.js) the first time
// the user exports, so it costs nothing on a normal page view. ExcelJS (not
// SheetJS) because the free build supports full cell styling for brand fonts,
// fills, and borders.
function withExcelJS(cb) {
  if (window.ExcelJS) { cb(); return; }
  const existing = document.getElementById("exceljs-lib");
  if (existing) { existing.addEventListener("load", () => cb(), { once: true }); return; }
  const s = document.createElement("script");
  s.id = "exceljs-lib";
  s.src = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  s.onload = () => cb();
  s.onerror = () => window.alert("Couldn't load the Excel export library. Check your connection and try again.");
  document.head.appendChild(s);
}

function dateStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Subtext masterbrand palette as Excel ARGB, plus the brand typefaces.
const XLC = {
  everest: "FF16352E", beigeDeep: "FFEDE5CF", beige: "FFF7F1E3",
  slate: "FF2B2825", slate70: "FF5A544F", white: "FFFFFFFF",
  birch: "FFA95818", warn: "FFC79830",
};
const XL_HEAD_FONT = "Mencken Std";   // brand serif (title band)
const XL_BODY_FONT = "Pragmatica";    // brand sans (everything else)
function xlFill(argb) { return { type: "pattern", pattern: "solid", fgColor: { argb } }; }

/* ----- Pipeline scorecard (grouped by market stage) ----------
   The Industry scorecard is a monthly-market-update layout: one table per
   CRM stage (Upcoming / Assessing / Pursuing), each with a green stage band.
   Shared by the on-screen render and the Excel export. */

const PIPELINE_STAGES = [
  { key: "pursuing",  label: "Markets - Pursuing" },
  { key: "assessing", label: "Markets - Assessing" },
  { key: "upcoming",  label: "Markets - Upcoming" },
  // Pseudo-stage: every market with no CRM stage that the development or
  // acquisitions forward model ranks.
  { key: "ranked",    label: "Markets - Tracking" },
];

// Derived-column maps built once from DATA (the pipeline set is small).
let _pipelineDerived = null;
function pipelineDerived() {
  if (_pipelineDerived) return _pipelineDerived;
  const t = DATA.tables;
  const fteGrowth = new Map((t.fte_history || []).map((f) => [f.market_key, f.yoy_fte_growth]));
  const yoyRent = new Map((t.rent_yoy || []).map((r) => [r.market_key, r.yoy_rent_growth]));
  const qualScore = new Map((t.market_qualifiers || []).map((q) => [q.market_key, q.score_pct]));
  // R1 status comes from the power4_r1 qualifier result rather than a second
  // copy of the Carnegie list in JS: actual_display is "Power 4 + R1",
  // "Power 4", "R1", "Neither", or "-" (city market, no anchor).
  const r1Status = new Map((t.market_qualifiers || []).map((q) => {
    const disp = (q.results || []).find((r) => r.id === "power4_r1")?.actual_display;
    return [q.market_key, !disp || disp === "-" ? null : disp.includes("R1") ? "Yes" : "No"];
  }));
  // Prelease YoY: the prelease_lag qualifier's actual is already the
  // same-week-of-cycle delta vs the prior leasing cycle (pct points).
  const preleaseYoY = new Map((t.market_qualifiers || []).map((q) => {
    const r = (q.results || []).find((x) => x.id === "prelease_lag");
    return [q.market_key, r?.actual ?? null];
  }));
  // Student affluence (mean origin income), with the same minimum-sample
  // guard the all-markets table and income qualifier use.
  const affluence = new Map((t.market_affluence || []).map((a) =>
    [a.market_key, a.n_students >= 100 ? a.mean_origin_income : null]));
  const propsByMarket = new Map();
  (t.properties || []).forEach((p) => {
    if (!propsByMarket.has(p.market_key)) propsByMarket.set(p.market_key, []);
    propsByMarket.get(p.market_key).push(p);
  });
  // Per-property YoY rent growth from the annual (June) property_history
  // snapshots: latest year vs the year before. Zero/absent rents drop out.
  const hist = t.property_history || [];
  const years = [...new Set(hist.map((h) => h.year_))].sort((a, b) => a - b);
  const rentGrowth = new Map();
  if (years.length >= 2) {
    const [prior, latest] = years.slice(-2);
    const cur = new Map(), prev = new Map();
    for (const h of hist) {
      if (!(h.avg_rent_per_bed > 0)) continue;
      if (h.year_ === latest) cur.set(h.property_key, h.avg_rent_per_bed);
      else if (h.year_ === prior) prev.set(h.property_key, h.avg_rent_per_bed);
    }
    for (const [pk, c] of cur) {
      const p = prev.get(pk);
      if (p) rentGrowth.set(pk, c / p - 1);
    }
  }
  _pipelineDerived = { fteGrowth, yoyRent, qualScore, r1Status, preleaseYoY, affluence, propsByMarket, rentGrowth };
  return _pipelineDerived;
}

// Bed-weighted avg of getter(p) across a market's properties within `maxMi`
// of campus. Properties missing the value or a bed count are skipped.
function bedWeighted(props, maxMi, getter) {
  let num = 0, den = 0;
  for (const p of props) {
    const v = getter(p);
    if (v == null || !p.beds) continue;
    if (maxMi != null && (p.milesToClosestCampus == null || p.milesToClosestCampus > maxMi)) continue;
    num += v * p.beds; den += p.beds;
  }
  return den ? num / den : null;
}

// Pipeline beds within `maxMi` of campus. Same phase set as the market
// pipeline total (beds_lease_up + beds_under_construction + beds_planned)
// and the Pipeline tab on the market page.
const PIPELINE_BED_PHASES = new Set(["under construction", "lease up", "planned"]);
function pipelineBedsWithin(props, maxMi) {
  let beds = 0;
  for (const p of props) {
    if (!PIPELINE_BED_PHASES.has(p.phase) || !p.beds) continue;
    if (p.milesToClosestCampus == null || p.milesToClosestCampus > maxMi) continue;
    beds += p.beds;
  }
  return beds;
}

// Uncaptured demand within 1 mile: share of FTE not yet served by PBSH beds
// near campus - mirrors the uncaptured_1mi qualifier in export-data.py.
// `minYear` restricts the supply side to newer vintages (e.g. built 2010+).
function uncapturedWithinMile(props, fte, minYear) {
  if (!fte) return null;
  let beds = 0;
  for (const p of props) {
    if (!p.beds || p.milesToClosestCampus == null || p.milesToClosestCampus > 1.0) continue;
    if (minYear != null && !(p.yearBuilt >= minYear)) continue;
    beds += p.beds;
  }
  return 1 - beds / fte;
}

// Scorecard rows: active markets (those with a market_status) plus any other
// market the forward models rank, augmented with the derived columns and
// filtered by the search box. Grouped by stage at render time.
function pipelineScorecardRows() {
  const d = pipelineDerived();
  const q = (document.getElementById("market-filter")?.value || "").trim().toLowerCase();
  return DATA.tables.scorecard
    .filter((r) => r.market_status || r.fwd_rank != null || r.acq_rank != null)
    .filter((r) => !q || marketMatchesQuery(r, q))
    .map((r) => {
      const props = d.propsByMarket.get(r.market_key) || [];
      // Zero occupancy means "not reporting" in the export (under-
      // construction / pre-delivery assets), not a real 0% - drop it.
      const occ = (p) => p.occupancy || null;
      const growth = (p) => d.rentGrowth.get(p.property_key) ?? null;
      return {
        ...r,
        fte_growth_yoy: d.fteGrowth.get(r.market_key) ?? null,
        qualifier_score: d.qualScore.get(r.market_key) ?? null,
        is_power4: r.anchor_university ? (POWER4_ANCHORS.has(r.anchor_university) ? "Yes" : "No") : null,
        is_r1: d.r1Status.get(r.market_key) ?? null,
        prelease_yoy: d.preleaseYoY.get(r.market_key) ?? null,
        mean_origin_income: d.affluence.get(r.market_key) ?? null,
        pipe_half_mi: pipelineBedsWithin(props, 0.5),
        pipe_one_mi: pipelineBedsWithin(props, 1.0),
        yoy_rent_growth: d.yoyRent.get(r.market_key) ?? null,
        rent_half_mi: bedWeighted(props, 0.5, (p) => p.avg_rent),
        rent_one_mi: bedWeighted(props, 1.0, (p) => p.avg_rent),
        occ_half_mi: bedWeighted(props, 0.5, occ),
        occ_one_mi: bedWeighted(props, 1.0, occ),
        rent_growth_half_mi: bedWeighted(props, 0.5, growth),
        rent_growth_one_mi: bedWeighted(props, 1.0, growth),
        ud_one_mi: uncapturedWithinMile(props, r.enr_full_time, null),
        ud_one_mi_2010: uncapturedWithinMile(props, r.enr_full_time, 2010),
        uncaptured_demand: r.penetration_ratio != null ? 1 - r.penetration_ratio : null,
      };
    })
    // Every stage section orders by qualifier score, best first (markets
    // without one sink to the bottom); A-Z only breaks ties.
    .sort((a, b) =>
      (b.qualifier_score ?? -Infinity) - (a.qualifier_score ?? -Infinity)
      || (a.anchor_university || "").localeCompare(b.anchor_university || ""));
}

// Column set - mirrors the monthly market update. `xz` = Excel number format.
// `h` is the flat label used by the Excel export; on screen, columns with a
// `group` render under a two-row header (family band over `sub` labels) and
// ungrouped columns span both rows.
const PIPELINE_COLS = [
  { h: "University",           uni: true },
  { h: "Dev Rank",             group: "Subtext Rank",      sub: "Dev.",         get: (r) => r.fwd_rank,            fmt: fmtInt,           xz: "#,##0" },
  { h: "Acq Rank",             group: "Subtext Rank",      sub: "Acq.",         get: (r) => r.acq_rank,            fmt: fmtInt,           xz: "#,##0" },
  { h: "Qualifier Score",      get: (r) => r.qualifier_score,     fmt: fmtQualScorePill, xz: "0%" },
  { h: "Power 4",              group: "Anchor",            sub: "Power 4",      get: (r) => r.is_power4,           fmt: fmtYesFlag },
  { h: "R1",                   group: "Anchor",            sub: "R1",           get: (r) => r.is_r1,               fmt: fmtYesFlag },
  { h: "Total Enrollment",     group: "Enrollment",        sub: "Total",        get: (r) => r.total_enrollment,    fmt: fmtInt,           xz: "#,##0" },
  { h: "FTE",                  group: "Enrollment",        sub: "FTE",          get: (r) => r.enr_full_time,       fmt: fmtInt,           xz: "#,##0" },
  { h: "FTE Growth",           group: "Enrollment",        sub: "FTE Growth",   get: (r) => r.fte_growth_yoy,      fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Occ - 0.5 Mi",         group: "Occupancy",         sub: "0.5 Mi",       get: (r) => r.occ_half_mi,         fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Occ - 1.0 Mi",         group: "Occupancy",         sub: "1.0 Mi",       get: (r) => r.occ_one_mi,          fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Market Occ.",          group: "Occupancy",         sub: "Market",       get: (r) => r.occupancy,           fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Market Prelease",      group: "Prelease",          sub: "Market",       get: (r) => r.prelease,            fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Prelease YoY",         group: "Prelease",          sub: "YoY",          get: (r) => r.prelease_yoy,        fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Rent - 0.5 Mi",        group: "Rent",              sub: "0.5 Mi",       get: (r) => r.rent_half_mi,        fmt: fmtUsd,           xz: "$#,##0" },
  { h: "Rent - 1.0 Mi",        group: "Rent",              sub: "1.0 Mi",       get: (r) => r.rent_one_mi,         fmt: fmtUsd,           xz: "$#,##0" },
  { h: "Market Rent",          group: "Rent",              sub: "Market",       get: (r) => r.avg_rent_per_bed,    fmt: fmtUsd,           xz: "$#,##0" },
  { h: "Rent Growth - 0.5 Mi", group: "Rent Growth",       sub: "0.5 Mi",       get: (r) => r.rent_growth_half_mi, fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Rent Growth - 1.0 Mi", group: "Rent Growth",       sub: "1.0 Mi",       get: (r) => r.rent_growth_one_mi,  fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Market Rent Growth",   group: "Rent Growth",       sub: "Market",       get: (r) => r.yoy_rent_growth,     fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Pipeline - Total",     group: "Pipeline",          sub: "Total",        get: (r) => r.beds_pipeline_total, fmt: fmtInt,           xz: "#,##0" },
  { h: "Pipeline - 0.5 Mi",    group: "Pipeline",          sub: "0.5 Mi",       get: (r) => r.pipe_half_mi,        fmt: fmtInt,           xz: "#,##0" },
  { h: "Pipeline - 1.0 Mi",    group: "Pipeline",          sub: "1.0 Mi",       get: (r) => r.pipe_one_mi,         fmt: fmtInt,           xz: "#,##0" },
  { h: "UD - 1.0 Mi",          group: "Uncaptured Demand", sub: "1.0 Mi",       get: (r) => r.ud_one_mi,           fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "UD - 1.0 Mi (2010+)",  group: "Uncaptured Demand", sub: "1.0 Mi 2010+", get: (r) => r.ud_one_mi_2010,      fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "UD as FTE %",          group: "Uncaptured Demand", sub: "Market",       get: (r) => r.uncaptured_demand,   fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Student Affluence",    get: (r) => r.mean_origin_income,  fmt: fmtUsd,           xz: "$#,##0" },
];

// True when column `i` opens a new header group (used for divider borders).
function pipelineGroupStart(i) {
  const c = PIPELINE_COLS[i];
  return !!c.group && PIPELINE_COLS[i - 1]?.group !== c.group;
}

function pipelineRowsByStage(rows) {
  const byStage = new Map(PIPELINE_STAGES.map((s) => [s.key, []]));
  rows.forEach((r) => {
    const key = r.market_status || "ranked";
    if (byStage.has(key)) byStage.get(key).push(r);
  });
  return byStage;
}

// Export the market update as a branded .xlsx: one green-banded section per
// stage, real numbers with Excel number formats.
function downloadScorecardExcel() {
  const rows = pipelineScorecardRows();
  const byStage = pipelineRowsByStage(rows);
  const nCol = PIPELINE_COLS.length;
  const asOf = (document.getElementById("data-as-of")?.textContent || "").trim();

  withExcelJS(async () => {
    const wb = new ExcelJS.Workbook();
    wb.creator = "SubHouse";
    const ws = wb.addWorksheet("Market Update", { views: [{ state: "frozen", xSplit: 1 }] });
    ws.getColumn(1).width = 34;
    for (let i = 2; i <= nCol; i++) ws.getColumn(i).width = 11;

    let rownum = 1;
    // Title band.
    ws.mergeCells(rownum, 1, rownum, nCol);
    const title = ws.getCell(rownum, 1);
    title.value = "Monthly Market Update" + (asOf && asOf !== "-" ? "   ·   Data as of " + asOf : "");
    title.font = { name: XL_HEAD_FONT, size: 15, bold: true, color: { argb: XLC.white } };
    title.fill = xlFill(XLC.everest);
    title.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    ws.getRow(rownum).height = 26;
    rownum += 2;

    for (const stage of PIPELINE_STAGES) {
      const list = byStage.get(stage.key) || [];
      if (!list.length) continue;
      // Stage band.
      ws.mergeCells(rownum, 1, rownum, nCol);
      const band = ws.getCell(rownum, 1);
      band.value = `${stage.label}  (${list.length})`;
      band.font = { name: XL_HEAD_FONT, size: 12, bold: true, color: { argb: XLC.white } };
      band.fill = xlFill(XLC.everest);
      band.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
      ws.getRow(rownum).height = 20;
      rownum++;
      // Header row.
      const hr = ws.getRow(rownum);
      hr.height = 28;
      PIPELINE_COLS.forEach((c, i) => {
        const cell = hr.getCell(i + 1);
        cell.value = c.h;
        cell.font = { name: XL_BODY_FONT, size: 9, bold: true, color: { argb: XLC.slate } };
        cell.fill = xlFill(XLC.beigeDeep);
        cell.alignment = { vertical: "middle", horizontal: c.uni ? "left" : "right", wrapText: true, indent: 1 };
        cell.border = { bottom: { style: "medium", color: { argb: XLC.everest } } };
      });
      rownum++;
      // Data rows.
      list.forEach((r) => {
        const row = ws.getRow(rownum);
        PIPELINE_COLS.forEach((c, i) => {
          const cell = row.getCell(i + 1);
          if (c.uni) {
            cell.value = r.anchor_university || "";
            cell.font = { name: XL_BODY_FONT, size: 10, bold: true, color: { argb: XLC.slate } };
            cell.alignment = { horizontal: "left", indent: 1 };
          } else {
            const v = c.get(r);
            cell.value = (v == null ? null : v);
            if (c.xz && typeof v === "number") cell.numFmt = c.xz;
            cell.font = { name: XL_BODY_FONT, size: 10, color: { argb: XLC.slate } };
            cell.alignment = { horizontal: "right", indent: 1 };
          }
          cell.border = { bottom: { style: "thin", color: { argb: XLC.beigeDeep } } };
        });
        rownum++;
      });
      rownum++;   // spacer between stages
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `subhouse-market-update-${dateStamp()}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

/* Custom autocomplete for the market search box. Suggestions are drawn from
   the ENTIRE tracked universe (every scorecard market), independent of the
   map toggles. Behavior: nothing shows until the first character is typed,
   at most 5 suggestions appear, and clicking one opens that market's page. */
let MARKET_SEARCH = [];          // [{ key, name, place, hay }]
const SEARCH_SUGGEST_MAX = 5;

function buildMarketSearchIndex() {
  // One suggestion per university, not per market, so every school in a
  // multi-university market (e.g. University of Miami alongside FIU) is
  // findable in its own right. Non-anchor entries deep-link to the market's
  // University tab with that school preselected.
  const seen = new Set();
  MARKET_SEARCH = [];
  for (const r of DATA.tables.scorecard) {
    if (seen.has(r.market_key)) continue;
    seen.add(r.market_key);
    const place = [r.city, r.state_abbr].filter(Boolean).join(", ");
    const unis = MARKET_UNIS.get(r.market_key) || [];
    const names = new Set();
    for (const u of unis) {
      if (names.has(u.name)) continue;
      names.add(u.name);
      MARKET_SEARCH.push({
        key: r.market_key,
        school: u.name === r.anchor_university ? null : u.school_key,
        name: u.name,
        place,
        hay: `${u.name} ${r.city || ""} ${r.state_abbr || ""}`.toLowerCase(),
      });
    }
    if (r.anchor_university && !names.has(r.anchor_university)) {
      MARKET_SEARCH.push({
        key: r.market_key,
        school: null,
        name: r.anchor_university,
        place,
        hay: `${r.anchor_university} ${r.city || ""} ${r.state_abbr || ""}`.toLowerCase(),
      });
    }
  }
  MARKET_SEARCH.sort((a, b) => a.name.localeCompare(b.name));
}

// Does this scorecard row match the search query? Matches the anchor, the
// city/state, or ANY university in the market.
function marketMatchesQuery(r, q) {
  return (r.anchor_university || "").toLowerCase().includes(q)
    || (r.city || "").toLowerCase().includes(q)
    || (r.state_abbr || "").toLowerCase().includes(q)
    || (MARKET_UNIS.get(r.market_key) || []).some((u) => u.name.toLowerCase().includes(q));
}

function currentSearchMatches() {
  const q = document.getElementById("market-filter").value.trim().toLowerCase();
  if (q.length < 1) return [];   // only suggest once the user has typed
  return MARKET_SEARCH.filter((m) => m.hay.includes(q)).slice(0, SEARCH_SUGGEST_MAX);
}

function renderSearchSuggestions() {
  const input = document.getElementById("market-filter");
  const box = document.getElementById("market-suggest");
  if (!input || !box) return;
  const matches = currentSearchMatches();
  if (!matches.length) {
    box.hidden = true;
    box.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    return;
  }
  box.innerHTML = matches.map((m) =>
    `<button type="button" class="search-suggest-item" role="option" data-key="${m.key}"${m.school != null ? ` data-school="${m.school}"` : ""}>
       <span class="search-suggest-name">${escapeHtml(m.name)}</span>
       <span class="search-suggest-place">${escapeHtml(m.place)}</span>
     </button>`).join("");
  box.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function openMarket(key, school) {
  if (key == null) return;
  // A non-anchor school opens the market page on its University tab with
  // that school preselected (market.js reads ?school= and #university).
  window.location.href = school != null
    ? `market.html?id=${key}&school=${school}#university`
    : `market.html?id=${key}`;
}

function bindMarketSearch() {
  const input = document.getElementById("market-filter");
  const box = document.getElementById("market-suggest");
  if (!input || !box) return;

  // Click a suggestion -> open that market directly.
  box.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".search-suggest-item");
    if (!item) return;
    e.preventDefault();             // keep focus; fire before input blur
    openMarket(Number(item.dataset.key),
      item.dataset.school != null ? Number(item.dataset.school) : null);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const top = currentSearchMatches()[0];
      if (top) { e.preventDefault(); openMarket(top.key, top.school); }
    } else if (e.key === "Escape") {
      box.hidden = true;
      input.setAttribute("aria-expanded", "false");
    }
  });

  // Re-show on focus only if there is already a query.
  input.addEventListener("focus", renderSearchSuggestions);
  // Hide when focus leaves the search box (slight delay so clicks register).
  input.addEventListener("blur", () => setTimeout(() => {
    box.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }, 150));
}

/* ----- UI bindings ------------------------------------------- */

function bindUI() {
  document.getElementById("market-filter").addEventListener("input", () => {
    renderAll();
    renderSearchSuggestions();
  });
  // Market scope dropdown - Active markets (the pipeline board) is the
  // default lens; Subtext-30 / Power 4 are focus subsets; All markets is
  // the whole tracked universe.
  const scope = document.getElementById("market-scope");
  // Surface the total in the option label so the count is visible up front.
  const activeTotal = DATA.tables.scorecard.filter((r) => r.market_status).length;
  const activeOpt = scope.querySelector('option[value="active"]');
  if (activeTotal && activeOpt) {
    activeOpt.textContent = `Active markets (${activeTotal})`;
  }
  // Fill the pipeline-stage legend counts once (they don't change with filters).
  for (const stage of ["upcoming", "assessing", "pursuing"]) {
    const el = document.getElementById(`legend-count-${stage}`);
    if (el) {
      el.textContent = `(${DATA.tables.scorecard.filter((r) => r.market_status === stage).length})`;
    }
  }
  syncLegendMode();
  scope.addEventListener("change", () => {
    syncLegendMode();
    renderAll();
  });

  const xlsxBtn = document.getElementById("scorecard-xlsx");
  if (xlsxBtn) xlsxBtn.addEventListener("click", downloadScorecardExcel);
}

/* ----- KPI strip --------------------------------------------- */

function renderKpis(rows) {
  if (!document.getElementById("kpi-markets")) return;  // KPI strip removed from the Industry tab
  // Markets tracked
  const totalMarkets = DATA.tables.scorecard.length;
  const visible = rows.length;
  const s30 = DATA.tables.scorecard.filter((r) => r.is_subtext30 === 1).length;
  document.getElementById("kpi-markets").textContent = fmtInt(visible);
  document.getElementById("kpi-markets-sub").textContent =
    visible === totalMarkets
      ? `${fmtInt(totalMarkets)} total · ${s30} Subtext-30`
      : `of ${fmtInt(totalMarkets)} total`;

  // Existing beds total
  const beds = rows.reduce((a, r) => a + (r.existing_beds || 0), 0);
  document.getElementById("kpi-beds").textContent = fmtInt(beds);
  const avgBeds = rows.length ? beds / rows.length : 0;
  document.getElementById("kpi-beds-sub").textContent =
    rows.length ? `${fmtInt(avgBeds)} avg per market` : "-";

  // Pipeline beds total
  const pipe = rows.reduce((a, r) => a + (r.beds_pipeline_total || 0), 0);
  document.getElementById("kpi-pipeline").textContent = fmtInt(pipe);
  const pipePct = beds > 0 ? (pipe / beds) : null;
  document.getElementById("kpi-pipeline-sub").textContent =
    pipePct != null ? `${fmtPct(pipePct, 0)} of existing supply` : "-";

  // Bed-weighted average rent
  let rentSum = 0, weight = 0;
  for (const r of rows) {
    if (r.avg_rent_per_bed != null && r.existing_beds != null) {
      rentSum += r.avg_rent_per_bed * r.existing_beds;
      weight += r.existing_beds;
    }
  }
  const avgRent = weight > 0 ? rentSum / weight : null;
  document.getElementById("kpi-rent").textContent = fmtUsd(avgRent);
  document.getElementById("kpi-rent-sub").textContent =
    weight > 0 ? `weighted by ${fmtInt(weight)} beds` : "-";

  // page subtitle - element optional (was removed from layout)
  const mc = document.getElementById("market-count");
  if (mc) mc.textContent = fmtInt(totalMarkets);
}

/* ----- Scorecard table --------------------------------------- */

// One table per stage: a green stage band, a column header row, then the
// markets in that stage (qualifier score, best first). Clicking a row opens
// the market page.
function renderScorecard() {
  const container = document.getElementById("pipeline-stages");
  if (!container) return;
  const rows = pipelineScorecardRows();
  const byStage = pipelineRowsByStage(rows);
  const nCol = PIPELINE_COLS.length;
  // Two-row header: metric-family bands over short variant labels; ungrouped
  // columns span both rows. data-col/data-group drive the crosshair hover.
  const groupCells = [];
  const subCells = [];
  PIPELINE_COLS.forEach((c, i) => {
    if (!c.group) {
      groupCells.push(`<th rowspan="2" class="${c.uni ? "" : "num"} solo-head"${c.uni ? "" : ` data-col="${i}"`}>${escapeHtml(c.h)}</th>`);
      return;
    }
    if (pipelineGroupStart(i)) {
      const span = PIPELINE_COLS.filter((x) => x.group === c.group).length;
      groupCells.push(`<th colspan="${span}" class="group-head" data-group="${escapeHtml(c.group)}">${escapeHtml(c.group)}</th>`);
    }
    subCells.push(`<th class="num sub-head${pipelineGroupStart(i) ? " group-start" : ""}" data-col="${i}">${escapeHtml(c.sub)}</th>`);
  });

  // One table for every stage (band + headers repeat per section) so the
  // browser sizes each column once across Pursuing/Assessing/Upcoming and
  // all three sections line up with the same natural widths.
  let sections = "";
  let stagesShown = 0;
  for (const stage of PIPELINE_STAGES) {
    const list = byStage.get(stage.key) || [];
    if (!list.length) continue;
    stagesShown++;
    const body = list.map((r) => {
      const star = r.is_subtext30 === 1
        ? `<span class="s30-star" title="Subtext-30 focus market">★</span>` : "";
      const cells = PIPELINE_COLS.map((c, i) => {
        if (c.uni) {
          const others = (MARKET_UNIS.get(r.market_key) || [])
            .filter((u) => u.name !== r.anchor_university)
            .map((u) => `<span class="uni-extra">${escapeHtml(u.name)}</span>`)
            .join("");
          return `<td class="university-cell">${star}${escapeHtml(r.anchor_university || "")}${others}`
            + `<span class="city-state">${escapeHtml([r.city, r.state_abbr].filter(Boolean).join(", "))}</span></td>`;
        }
        const v = c.get(r);
        return `<td class="num${pipelineGroupStart(i) ? " group-start" : ""}" data-col="${i}">${v == null ? '<span class="muted">-</span>' : c.fmt(v)}</td>`;
      }).join("");
      return `<tr data-market-key="${r.market_key}">${cells}</tr>`;
    }).join("");
    sections += `
        <tbody class="stage-section">
          <tr class="stage-band"><th colspan="${nCol}">${escapeHtml(stage.label)}<span class="stage-count">${list.length}</span></th></tr>
          <tr class="stage-head stage-head-groups">${groupCells.join("")}</tr>
          <tr class="stage-head stage-head-subs">${subCells.join("")}</tr>
          ${body}
        </tbody>`;
  }
  container.innerHTML = sections
    ? `<table class="pipeline-table">${sections}</table>`
    : `<div class="empty-state">No active-pipeline markets match the filter.</div>`;
  container.querySelectorAll("tbody tr[data-market-key]").forEach((tr) => {
    tr.addEventListener("click", () => {
      window.location.href = `market.html?id=${Number(tr.dataset.marketKey)}`;
    });
  });

  // Crosshair hover: the row highlight (CSS tr:hover) shows the school; this
  // lights up the hovered stat's column and its header labels vertically.
  container.querySelectorAll("table.pipeline-table").forEach((tbl) => {
    const clear = () =>
      tbl.querySelectorAll(".col-hover").forEach((el) => el.classList.remove("col-hover"));
    tbl.addEventListener("mouseover", (e) => {
      const cell = e.target.closest("[data-col]");
      clear();
      if (!cell || !tbl.contains(cell)) return;
      // Highlight only within the hovered stage section, not the whole table.
      const section = cell.closest("tbody.stage-section") || tbl;
      const idx = cell.dataset.col;
      section.querySelectorAll(`[data-col="${idx}"]`).forEach((el) => el.classList.add("col-hover"));
      const g = PIPELINE_COLS[Number(idx)]?.group;
      if (g) {
        section.querySelectorAll(`th[data-group="${g}"]`).forEach((el) => el.classList.add("col-hover"));
      }
    });
    tbl.addEventListener("mouseleave", clear);
  });

  const rc = document.getElementById("result-count");
  if (rc) {
    const active = rows.filter((r) => r.market_status).length;
    const ranked = rows.length - active;
    const activeStages = Math.max(0, stagesShown - (ranked ? 1 : 0));
    rc.textContent = rows.length
      ? `${active} active markets across ${activeStages} stage${activeStages === 1 ? "" : "s"}`
        + (ranked ? ` · ${ranked} more forward-model ranked` : "")
      : "No active-pipeline markets";
  }
}

/* ----- Charts ------------------------------------------------ */

/* Register datalabels plugin once. Used on the less-dense charts where
   value labels fit; left off the top-30 stacked supply chart to avoid
   visual clutter. */
if (typeof Chart !== "undefined" && window.ChartDataLabels) {
  Chart.register(window.ChartDataLabels);
}

/* Shared chart defaults - deck language: no gridlines, bold Pragmatica
   ticks, no chart-level legend (cards already have headers). */
const CHART_FONT = "Pragmatica, sans-serif";
function deckCleanScale(axisOpts = {}) {
  return {
    grid: { display: false, drawTicks: false },
    border: { display: false },
    ticks: { font: { size: 11, weight: 600, family: CHART_FONT }, color: C.slate, autoSkip: false, ...axisOpts.ticks },
    ...axisOpts,
  };
}

function rowKey(rows, idx) { return rows[idx]?.market_key; }

function renderSupply(rows) {
  const pipeByKey = new Map(DATA.tables.pipeline_beds.map((r) => [r.market_key, r]));
  const top = rows.filter((r) => r.existing_beds != null)
    .map((r) => ({
      ...r,
      pipe: (pipeByKey.get(r.market_key)?.beds_pipeline_total) || 0,
    }))
    .sort((a, b) => (b.existing_beds + b.pipe) - (a.existing_beds + a.pipe))
    .slice(0, 30);

  const ctx = document.getElementById("supply-chart");
  if (!ctx) return;  // chart removed from the Industry tab
  if (charts.supply) charts.supply.destroy();
  charts.supply = new Chart(ctx, {
    type: "bar",
    data: {
      labels: top.map((r) => r.anchor_university),
      datasets: [
        { label: "Existing",     stack: "s", backgroundColor: C.slate,
          data: top.map((r) => r.existing_beds || 0) },
        { label: "Lease-up",     stack: "s", backgroundColor: C.everest,
          data: top.map((r) => pipeByKey.get(r.market_key)?.beds_lease_up || 0) },
        { label: "Under const.", stack: "s", backgroundColor: C.lime,
          data: top.map((r) => pipeByKey.get(r.market_key)?.beds_under_construction || 0) },
        { label: "Planned",      stack: "s", backgroundColor: C.slate30,
          data: top.map((r) => pipeByKey.get(r.market_key)?.beds_planned || 0) },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 14, boxHeight: 14, font: { size: 11, weight: 600, family: CHART_FONT }, color: C.slate, padding: 12 } },
        datalabels: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => fullLabel(rowKey(top, items[0].dataIndex)),
            label: (ctx) => `${ctx.dataset.label}: ${fmtInt(ctx.parsed.x)} beds`,
          },
        },
      },
      scales: {
        x: { stacked: true, ...deckCleanScale({ ticks: { callback: (v) => fmtInt(v), font: { size: 11, weight: 600, family: CHART_FONT }, color: C.slate70 } }) },
        y: { stacked: true, ...deckCleanScale({ ticks: { autoSkip: false, font: { size: 10, weight: 600, family: CHART_FONT }, color: C.slate } }) },
      },
    },
  });
}

function renderPricing(rows) {
  renderRentLevels(rows);
  renderRentGrowth(rows);
}

function renderRentLevels(rows) {
  const top = rows.filter((r) => r.avg_rent_per_bed != null)
    .sort((a, b) => b.avg_rent_per_bed - a.avg_rent_per_bed)
    .slice(0, 30);
  const ctx = document.getElementById("pricing-rent-chart");
  if (!ctx) return;
  if (charts.pricingRent) charts.pricingRent.destroy();
  charts.pricingRent = new Chart(ctx, {
    type: "bar",
    data: {
      labels: top.map((r) => r.anchor_university),
      datasets: [{
        data: top.map((r) => Number(r.avg_rent_per_bed)),
        backgroundColor: top.map((r) => r.is_subtext30 === 1 ? C.everest : C.slate30),
        borderRadius: 3,
        barThickness: 12,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        datalabels: {
          anchor: "end", align: "end", offset: 4, clip: false,
          font: { weight: 700, size: 10, family: CHART_FONT },
          color: C.slate,
          formatter: (v) => v == null ? "" : fmtUsd(v),
        },
        tooltip: {
          callbacks: {
            title: (items) => fullLabel(rowKey(top, items[0].dataIndex)),
            label: (c) => `Avg rent: ${fmtUsd(c.parsed.x)}`,
          },
        },
      },
      layout: { padding: { top: 4, right: 60, left: 4, bottom: 4 } },
      scales: {
        x: deckCleanScale({ ticks: { callback: (v) => fmtUsd(v), font: { size: 11, weight: 600, family: CHART_FONT }, color: C.slate70 } }),
        y: deckCleanScale({ ticks: { autoSkip: false, font: { size: 11, weight: 600, family: CHART_FONT }, color: C.slate } }),
      },
    },
  });
}

function renderRentGrowth(rows) {
  const yoyByKey = new Map(DATA.tables.rent_yoy.map((r) => [r.market_key, r.yoy_rent_growth]));
  const top = rows
    .map((r) => ({ ...r, yoy: yoyByKey.get(r.market_key) }))
    .filter((r) => r.yoy != null)
    .sort((a, b) => b.yoy - a.yoy)
    .slice(0, 30);
  const ctx = document.getElementById("pricing-growth-chart");
  if (!ctx) return;
  if (charts.pricingGrowth) charts.pricingGrowth.destroy();
  charts.pricingGrowth = new Chart(ctx, {
    type: "bar",
    data: {
      labels: top.map((r) => r.anchor_university),
      datasets: [{
        data: top.map((r) => r.yoy * 100),
        backgroundColor: top.map((r) => r.yoy >= 0 ? C.lime : C.birch),
        borderRadius: 3,
        barThickness: 12,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        datalabels: {
          anchor: (c) => (c.dataset.data[c.dataIndex] || 0) >= 0 ? "end" : "start",
          align:  (c) => (c.dataset.data[c.dataIndex] || 0) >= 0 ? "end" : "start",
          offset: 4, clip: false,
          font: { weight: 700, size: 10, family: CHART_FONT },
          color: C.slate,
          formatter: (v) => v == null ? "" : `${v.toFixed(1)}%`,
        },
        tooltip: {
          callbacks: {
            title: (items) => fullLabel(rowKey(top, items[0].dataIndex)),
            label: (c) => `YoY rent growth: ${c.parsed.x.toFixed(1)}%`,
          },
        },
      },
      layout: { padding: { top: 4, right: 60, left: 24, bottom: 4 } },
      scales: {
        x: deckCleanScale({ ticks: { callback: (v) => v.toFixed(0) + "%", font: { size: 11, weight: 600, family: CHART_FONT }, color: C.slate70 } }),
        y: deckCleanScale({ ticks: { autoSkip: false, font: { size: 11, weight: 600, family: CHART_FONT }, color: C.slate } }),
      },
    },
  });
}

/* ----- Pre-leasing velocity ---------------------------------- */

function renderVelocity() {
  const select = document.getElementById("velocity-market");
  if (!select) return;  // chart removed from the Industry tab
  if (select.options.length === 0) {
    // List markets that have prelease data - labeled by anchor university.
    const present = [...new Set(DATA.tables.prelease_velocity.map((r) => r.market_key))];
    const items = present
      .map((k) => ({ key: k, label: shortLabel(k) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    items.forEach(({ key, label }) => {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = label;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => drawVelocityChart(Number(select.value)));

    // Default: market with most data points
    const counts = {};
    DATA.tables.prelease_velocity.forEach((r) => {
      counts[r.market_key] = (counts[r.market_key] || 0) + 1;
    });
    if (items.length > 0) {
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      select.value = best;
    }
  }
  drawVelocityChart(Number(select.value));
}

function drawVelocityChart(marketKey) {
  const rows = DATA.tables.prelease_velocity.filter((r) => r.market_key === marketKey);
  const cycles = [...new Set(rows.map((r) => r.leasing_cycle))].sort((a, b) => a - b);
  const palette = [C.slate30, C.brown, C.everest]; // older → newer; latest = everest green

  const datasets = cycles.map((cycle, i) => {
    const cycleRows = rows.filter((r) => r.leasing_cycle === cycle)
      .sort((a, b) => a.week_of_cycle - b.week_of_cycle);
    const isLatest = i === cycles.length - 1;
    return {
      label: `Cycle ${cycle}`,
      data: cycleRows.map((r) => ({ x: r.week_of_cycle, y: r.prelease_pct * 100 })),
      borderColor: palette[i % palette.length],
      backgroundColor: palette[i % palette.length],
      borderWidth: isLatest ? 2.5 : 1.5,
      pointRadius: isLatest ? 3 : 1.5,
      pointBackgroundColor: palette[i % palette.length],
      tension: 0.25,
    };
  });

  const ctx = document.getElementById("velocity-chart");
  if (charts.velocity) charts.velocity.destroy();
  charts.velocity = new Chart(ctx, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "top", align: "end", labels: { boxWidth: 16, boxHeight: 4, font: { size: 11, weight: 600, family: CHART_FONT }, color: C.slate, padding: 12 } },
        datalabels: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%` } },
      },
      scales: {
        x: { type: "linear", min: 1, max: 53,
             ticks: { stepSize: 8, font: { size: 11, weight: 600, family: CHART_FONT }, color: C.slate70, callback: (v) => `Wk ${v}` },
             grid: { display: false },
             border: { color: C.beigeDeep } },
        y: { min: 0, max: 100,
             ticks: { stepSize: 20, font: { size: 11, weight: 600, family: CHART_FONT }, color: C.slate70, callback: (v) => v + "%" },
             grid: { color: "#f5efde", drawTicks: false },
             border: { display: false } },
      },
    },
  });
}

/* ----- Map helpers ------------------------------------------ */

// Adds a small fullscreen toggle button to a Leaflet map. Uses the native
// Fullscreen API; resizes the map after the transition so tiles fill the
// new viewport.
function addFullscreenControl(map) {
  const FsControl = L.Control.extend({
    onAdd() {
      const div = L.DomUtil.create("div", "leaflet-bar leaflet-control leaflet-fs-control");
      const a = L.DomUtil.create("a", "", div);
      a.href = "#";
      a.title = "Toggle fullscreen";
      a.innerHTML = "⛶";
      a.setAttribute("aria-label", "Toggle fullscreen");
      L.DomEvent.on(a, "click", (e) => {
        L.DomEvent.preventDefault(e);
        L.DomEvent.stopPropagation(e);
        const el = map.getContainer();
        const isFs = document.fullscreenElement || document.webkitFullscreenElement;
        if (!isFs) {
          (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
        } else {
          (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        }
      });
      return div;
    },
  });
  new FsControl({ position: "topright" }).addTo(map);

  const onChange = () => setTimeout(() => map.invalidateSize(), 120);
  document.addEventListener("fullscreenchange", onChange);
  document.addEventListener("webkitfullscreenchange", onChange);
}

/* ----- National map of all tracked markets ------------------- */

// Pipeline-stage pin colours (used when "Active markets" is on). Neutral slate
// (Upcoming) -> amber (Assessing) -> everest green (Pursuing) reads as a funnel.
const STATUS_COLOR = {
  pursuing: "#16352e",   // everest
  assessing: "#c79830",  // warn / amber
  upcoming: "#837c75",   // slate50
};

// Show the pipeline-stage legend when the scope dropdown is on "Active
// markets", qualifier otherwise. The scope drives the map's pin colouring too.
function syncLegendMode() {
  const legend = document.querySelector(".map-legend");
  const scope = document.getElementById("market-scope");
  if (legend && scope) {
    legend.classList.toggle("legend-mode-active", scope.value === "active");
  }
}

function renderIndustryMap() {
  const el = document.getElementById("industry-map");
  if (!el) return;
  if (typeof L === "undefined") {
    // Leaflet still loading - try again once page load finishes
    window.addEventListener("load", renderIndustryMap, { once: true });
    return;
  }

  if (!industryMap) {
    industryMap = L.map("industry-map", {
      scrollWheelZoom: true,
      minZoom: 3,             // keeps the US comfortably in view
      worldCopyJump: false,
      maxBounds: [[-85, -180], [85, 180]],   // can't pan off the edge of the world
      maxBoundsViscosity: 1,
    }).setView([39.5, -98.5], 4);

    // Multiple basemap options - switch via the layer control in the corner.
    // noWrap: true stops tiles from repeating horizontally at low zooms.
    const baseLayers = {
      "Terrain": L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
        { attribution: "Tiles © Esri", maxZoom: 19, noWrap: true },
      ),
      "Satellite": L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { attribution: "Tiles © Esri, Maxar, Earthstar Geographics", maxZoom: 19, noWrap: true },
      ),
      "Street": L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        { attribution: "© OpenStreetMap contributors", maxZoom: 19, noWrap: true },
      ),
      "Light": L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        { attribution: "© OSM · © CARTO", subdomains: "abcd", maxZoom: 19, noWrap: true },
      ),
      "Dark": L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        { attribution: "© OSM · © CARTO", subdomains: "abcd", maxZoom: 19, noWrap: true },
      ),
    };
    // Default to Satellite for visual richness
    baseLayers.Satellite.addTo(industryMap);

    // State outlines overlay - non-interactive, thin contrasting stroke so it
    // reads on the satellite basemap without obscuring it. Falls back silently
    // if the GeoJSON file is missing.
    const stateOutlines = L.layerGroup();
    fetch("assets/geo/us-states.geojson", { cache: "force-cache" })
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((gj) => {
        L.geoJSON(gj, {
          interactive: false,
          style: {
            color: "#ffffff",
            weight: 1.1,
            opacity: 0.7,
            fill: false,
          },
        }).addTo(stateOutlines);
      })
      .catch((err) => console.warn("state outlines unavailable:", err));
    stateOutlines.addTo(industryMap);

    L.control
      .layers(baseLayers, { "State outlines": stateOutlines },
              { position: "topright", collapsed: false })
      .addTo(industryMap);

    addFullscreenControl(industryMap);
    industryMarkerLayer = L.layerGroup().addTo(industryMap);
  }

  industryMarkerLayer.clearLayers();
  const rows = visibleScorecardRows();

  // Color each pin by its qualifier-score tier (green / amber / red / gray).
  // Subtext-30 markets get a thicker lime ring so they stand out at a glance.
  function pinColor(score) {
    if (score == null) return "#b6b1ab";           // slate-30 (na)
    const pct = score * 100;
    if (pct >= 80) return "#16352e";               // everest green
    if (pct >= 60) return "#c79830";               // warn / amber
    return "#a95818";                              // birch / rust
  }

  // In "Active markets" mode, colour pins by pipeline stage instead of qualifier
  // score; fall back to qualifier colour for any pin without a status (e.g. a
  // search result outside the active board).
  const activeMode = document.getElementById("market-scope")?.value === "active";
  const fillFor = (r) =>
    (activeMode && r.market_status && STATUS_COLOR[r.market_status]) || pinColor(r.qualifier_score);

  // Shared popup for both anchor and non-anchor pins. `uni` is null for the
  // anchor (market) pin; for a school pin the popup leads with that school
  // and its CTA deep-links to the University tab. The stats are market-wide
  // either way - SQL only carries beds/rent/score per market.
  function popupHtml(r, uni, isS30) {
    const scorePct = r.qualifier_score == null
      ? "-"
      : `${Math.round(r.qualifier_score * 100)}%`;
    const beds = r.existing_beds != null ? fmtInt(r.existing_beds) : "-";
    const rent = r.avg_rent_per_bed != null ? fmtUsd(r.avg_rent_per_bed) : "-";
    const accent = fillFor(r);
    const title = uni ? uni.name : (r.anchor_university || "");
    const siblings = (MARKET_UNIS.get(r.market_key) || [])
      .filter((u) => u.name !== title)
      .map((u) => u.name === r.anchor_university
        ? `<a href="market.html?id=${r.market_key}">${escapeHtml(u.name)}</a>`
        : `<a href="market.html?id=${r.market_key}&school=${u.school_key}#university">${escapeHtml(u.name)}</a>`)
      .join(" · ");
    const cta = uni
      ? `market.html?id=${r.market_key}&school=${uni.school_key}#university`
      : `market.html?id=${r.market_key}`;
    return `
      <div class="market-popup" style="--popup-accent:${accent}">
        <div class="market-popup-head">
          <div class="market-popup-title">${escapeHtml(title)}</div>
          ${siblings ? `<div class="market-popup-unis">${siblings}</div>` : ""}
          <div class="market-popup-sub">
            <span class="market-popup-loc">${escapeHtml(r.city || "")}, ${escapeHtml(r.state_abbr || "")}</span>
            ${r.market_status ? `<span class="market-popup-badge" style="background:${STATUS_COLOR[r.market_status]};color:#fff">${r.market_status.charAt(0).toUpperCase() + r.market_status.slice(1)}</span>` : ""}
            ${isS30 ? '<span class="market-popup-badge">★ Subtext-30</span>' : ""}
          </div>
        </div>
        <div class="market-popup-stats">
          <div class="market-popup-stat">
            <div class="market-popup-stat-value">${beds}</div>
            <div class="market-popup-stat-label">Existing beds</div>
          </div>
          <div class="market-popup-stat">
            <div class="market-popup-stat-value">${rent}</div>
            <div class="market-popup-stat-label">Avg rent</div>
          </div>
          <div class="market-popup-stat">
            <div class="market-popup-stat-value">${scorePct}</div>
            <div class="market-popup-stat-label">Qualifier</div>
          </div>
        </div>
        <a href="${cta}" class="market-popup-cta">Open market →</a>
      </div>
    `;
  }

  for (const r of rows) {
    const coords = ANCHOR_COORDS.get(r.market_key);
    if (!coords) continue;
    const isS30 = r.is_subtext30 === 1;
    const marker = L.circleMarker([coords.lat, coords.lng], {
      radius: isS30 ? 9 : 6,
      fillColor: fillFor(r),
      color: isS30 ? "#c1d100" : "#ffffff",        // lime ring for Subtext-30, white for others
      weight: isS30 ? 3 : 1.5,
      fillOpacity: 0.92,
    });
    marker.bindPopup(popupHtml(r, null, isS30),
      { maxWidth: 320, minWidth: 280, className: "market-popup-wrapper" });
    marker.on("click", () => marker.openPopup());
    marker.addTo(industryMarkerLayer);

    // Every other university in the market gets its own (smaller) pin at its
    // campus - no school hides behind the anchor. Same market color; the
    // Subtext-30 ring stays on the anchor pin only.
    for (const uni of MARKET_UNIS.get(r.market_key) || []) {
      if (uni.name === r.anchor_university) continue;
      if (uni.lat == null || uni.lng == null) continue;
      const uniMarker = L.circleMarker([uni.lat, uni.lng], {
        radius: 5,
        fillColor: fillFor(r),
        color: "#ffffff",
        weight: 1.5,
        fillOpacity: 0.85,
      });
      uniMarker.bindPopup(popupHtml(r, uni, isS30),
        { maxWidth: 320, minWidth: 280, className: "market-popup-wrapper" });
      uniMarker.on("click", () => uniMarker.openPopup());
      uniMarker.addTo(industryMarkerLayer);
    }
  }
}

/* ----- Master render ----------------------------------------- */

function renderAll() {
  const rows = visibleScorecardRows();
  renderIndustryMap();
  renderKpis(rows);
  renderScorecard();
  renderSupply(rows);
  renderPricing(rows);
}

/* ----- Forward Model iframe re-skin --------------------------- */
// forward-model.html / acquisitions-model.html are generated drop-ins that
// get replaced wholesale, so the Subtext branding is injected from outside:
// append the override stylesheet into each iframe document as it (re)loads.
// Scoped to #forward-view so the Market State iframe is not touched.
(function brandForwardModel() {
  document.querySelectorAll("#forward-view .forward-frame").forEach((frame) => {
    const inject = () => {
      try {
        const doc = frame.contentDocument;
        if (!doc || !doc.head || doc.getElementById("fwd-brand-css")) return;
        const link = doc.createElement("link");
        link.id = "fwd-brand-css";
        link.rel = "stylesheet";
        link.href = "forward-model-brand.css?v=1";
        doc.head.appendChild(link);
      } catch { /* same-origin, so this shouldn't throw */ }
    };
    frame.addEventListener("load", inject);
    inject();  // covers the already-loaded case
  });
})();

/* ----- Forward Model: Development / Acquisitions toggle -------- */
(function forwardModelToggle() {
  const btns = document.querySelectorAll("#forward-view .fwd-toggle-btn");
  const dev = document.getElementById("forward-frame-dev");
  const acq = document.getElementById("forward-frame-acq");
  if (!btns.length || !dev || !acq) return;
  btns.forEach((btn) => btn.addEventListener("click", () => {
    btns.forEach((b) => b.classList.toggle("active", b === btn));
    const showAcq = btn.dataset.model === "acq";
    if (showAcq && !acq.getAttribute("src")) acq.src = acq.dataset.src;
    dev.classList.toggle("fwd-hidden", showAcq);
    acq.classList.toggle("fwd-hidden", !showAcq);
  }));
})();
