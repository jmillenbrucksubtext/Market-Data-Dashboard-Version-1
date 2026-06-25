/* =============================================================
   Subtext Living - Market Detail page
   URL pattern: market.html?id=<market_key>
   Reads data.json, renders the market's KPIs, property list, and map.
   ============================================================= */

const NUM_FMT_INT = new Intl.NumberFormat("en-US");
const NUM_FMT_USD = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD",
  minimumFractionDigits: 0, maximumFractionDigits: 0,
});

const C = {
  slate:   "#2b2825",
  slate70: "#5a544f",
  slate30: "#b6b1ab",
  everest: "#16352e",
  birch:   "#a95818",
  brown:   "#512213",
  lime:    "#c1d100",
  warn:    "#c79830",
  good:    "#16352e",
  bad:     "#a95818",
};

let DATA = null;
let MARKET = null;
let PROPERTIES = [];
let CAMPUSES = [];
let LOGOS = new Map();   // market_key → logo filename (e.g., "14.png")
// Per-table sort state: both tables default to year built (newest deals on
// top).
let propSortStates = {
  "properties-all":   { col: "yearBuilt", dir: "desc" },
  "properties-comps": { col: "yearBuilt", dir: "desc" },
};
let map = null;
let propertyMarkers = new Map();  // market map: property_key → leaflet marker
let compSelection = new Set();  // property_keys currently checked on Comps tab
let compSelectionInit = false;  // defaults applied once; user edits persist after
let compCharts = {};  // canvas id → Chart instance
let perfScope = "market";  // Market Performance filter: market | 1mi | 0.5mi | 1mi2015
let perfCharts = {};       // tracked Market Performance chart instances (re-rendered on filter change)
let uniResidencyChart = null;  // University tab: undergrad residency doughnut
let uniAdmissionsChart = null; // University tab: applications/acceptance/yield combo
let unitMixMetric = "units";  // "beds" | "units" - Unit & Bed Mix toggle state (defaults to units)
let unitMixChart = null;     // Chart instance for the unit-mix stacked bar
let unitMixSizeChart = null; // Chart instance for the avg-unit-size grouped bar
let unitMixPieChart = null;  // Chart instance for the per-building pie
let unitMixPieBuilding = null;  // property_key (number) or "all" - pie scope
let unitMixParityChart = null;  // Chart instance for the bed/bath parity pie
let unitMixParityType = "all";  // bedroom-type filter for the parity pie
let pipeCharts = {};  // Pipeline tab: canvas id → Chart instance
let pipelineDistance = "all";  // "0.5" | "1" | "all" - campus-distance band
let shadowMarketData = null;
let shadowMarketMap = null;
let shadowMarketOverlay = null;
let shadowMarketLoadPromise = null;
let shadowMarketBoundaryData = null;
let shadowMarketBoundaryLoaded = false;

document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(location.search);
  const marketKey = Number(params.get("id"));
  if (!marketKey) {
    return showError("No market specified. Go back to the dashboard and pick one.");
  }

  try {
    const res = await fetch("data.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
  } catch (err) {
    return showError(`Couldn't load data.json - ${err}`);
  }

  // Optional: load campus logo manifest. Missing manifest is fine - every
  // market just falls back to the SVG building pin.
  try {
    const mRes = await fetch("assets/campus-logos/_manifest.json", { cache: "no-cache" });
    if (mRes.ok) {
      const manifest = await mRes.json();
      for (const e of manifest) {
        if (e.file && (e.status === "ok" || e.status === "ok_existing")) {
          LOGOS.set(e.market_key, e.file);
        }
      }
    }
  } catch { /* no manifest is fine */ }

  MARKET = DATA.tables.scorecard.find((r) => r.market_key === marketKey);
  if (!MARKET) return showError(`Market ${marketKey} not found.`);

  PROPERTIES = DATA.tables.properties.filter((p) => p.market_key === marketKey);
  CAMPUSES = DATA.tables.campus_locations.filter((c) => c.market_key === marketKey);

  document.getElementById("market-loading").style.display = "none";
  document.getElementById("market-view").style.display = "block";

  syncTopbarHeight();
  window.addEventListener("resize", syncTopbarHeight);

  setFreshness();
  renderHeader();
  renderKpis();
  renderQualifiers();
  renderProperties();
  bindPropertySort();
  renderLegend();
  renderPerformance();
  bindPerfScope();
  bindTabs();
  bindUnitMixToggle();
  bindPipelineToggle();
  bindShadowMarketControls();
  // Comp charts are hidden under the Comps tab on load; size will be 0
  // until the tab is shown, so we re-render via bindTabs. Build once now so
  // selection state is wired up.
  renderCompCharts();

  // Wait for Leaflet to load (deferred script)
  if (typeof L === "undefined") {
    await new Promise((r) => window.addEventListener("load", r, { once: true }));
  }
  renderMap();
});

/* ----- Market Performance (deck-style charts) ---------------- */

const PERF = {
  anchorColor:  "#a95818",   // rust / birch - anchor market
  benchColor:   "#16352e",   // everest - Subtext-30 average
  power4Color:  "#3d8aa6",   // blue - Power 4 university average
  pipeColors: {
    existing:           "#2b2825",  // slate
    lease_up:           "#16352e",  // everest
    under_construction: "#a95818",  // rust
    planned:            "#b6b1ab",  // slate30
  },
};

// Base titles for the four performance charts, and the suffix appended per
// active distance/vintage filter (blank for the whole-market default).
const PERF_TITLES = {
  "perf-rent":        "Market Rent",
  "perf-rent-growth": "Market Rent Growth",
  "perf-occupancy":   "Market Occupancy",
  "perf-prelease":    "Market Pre-lease",
};
const PERF_SCOPE_LABELS = {
  "market":   "",
  "1mi":      "1 Mile",
  "0.5mi":    "0.5 Mile",
  "1mi2015":  "1 Mile, 2015+",
};

// Stamp the active filter name into a performance chart's title, e.g.
// "Market Rent - 1 Mile". The whole-market default keeps the base title.
function setPerfTitle(canvasId) {
  const base = PERF_TITLES[canvasId];
  if (!base) return;
  const el = document.getElementById(canvasId)?.closest("figure")?.querySelector(".perf-title-text");
  if (!el) return;
  const suffix = PERF_SCOPE_LABELS[perfScope] || "";
  el.textContent = suffix ? `${base} - ${suffix}` : base;
}

// Power 4 anchor universities (2024-25 conference alignment), matched against
// scorecard.anchor_university. Kept in sync with dashboard.js POWER4_ANCHORS.
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

function s30Rows(table, joinKey = "market_key") {
  const s30Keys = new Set(
    DATA.tables.scorecard.filter((r) => r.is_subtext30 === 1).map((r) => r.market_key)
  );
  return DATA.tables[table].filter((r) => s30Keys.has(r[joinKey]));
}

function mean(arr) {
  const xs = arr.filter((x) => x != null && !isNaN(x));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function sumBy(rows, field) {
  let s = 0, any = false;
  for (const r of rows) {
    const v = r[field];
    if (v != null && !isNaN(v)) { s += v; any = true; }
  }
  return any ? s : null;
}

/** Shared Chart.js options for the deck-style benchmark charts. */
function perfBaseOpts({ valueFmt }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: { label: (c) => `${c.dataset.label || c.label}: ${valueFmt(c.parsed.y)}` },
      },
      datalabels: {
        anchor: "end",
        align: "end",
        offset: 4,
        clip: false,
        font: { weight: 700, size: 12, family: "Pragmatica, sans-serif" },
        color: "#2b2825",
        formatter: valueFmt,
      },
    },
    layout: { padding: { top: 24, right: 8, left: 8, bottom: 4 } },
    scales: {
      x: {
        grid: { display: false, drawBorder: false },
        ticks: { font: { size: 12, weight: 600, family: "Pragmatica, sans-serif" }, color: "#2b2825" },
        border: { display: false },
      },
      y: {
        display: false,
        beginAtZero: true,
      },
    },
  };
}

function renderPerformance() {
  if (typeof Chart === "undefined") return;
  if (window.ChartDataLabels) Chart.register(window.ChartDataLabels);
  // Each chart's top-right mini-legend has its own anchor-label span. Stamp
  // the market name into every one so they read "<Anchor University>" /
  // "Subtext-30 avg" instead of "This market" / "Subtext-30 avg".
  const anchorName = MARKET.anchor_university || "This market";
  document.querySelectorAll(".perf-legend-anchor-label").forEach((el) => {
    el.textContent = anchorName;
  });

  /* ---- Multi-year time series: rent, rent growth, occupancy, prelease ---- */
  // For each year, this market's value vs the Subtext-30 average for that same year.
  const history = DATA.tables.market_history || [];
  const s30Keys = new Set(
    DATA.tables.scorecard.filter((r) => r.is_subtext30 === 1).map((r) => r.market_key)
  );
  // Power 4 university markets, matched on anchor_university.
  const p4Keys = new Set(
    DATA.tables.scorecard.filter((r) => POWER4_ANCHORS.has(r.anchor_university)).map((r) => r.market_key)
  );
  const myHistory = history.filter((r) => r.market_key === MARKET.market_key)
    .sort((a, b) => a.year_ - b.year_);
  const years = myHistory.map((r) => r.year_);

  // Treat 0 as missing for these metrics - a real student-housing market
  // never has $0 rent or 0% occupancy/prelease; zeros mean "market not yet
  // tracked at this snapshot."
  const cleanZero = (v) => (v == null || v === 0) ? null : Number(v);

  // Per-year mean of `field` across a set of market keys, aligned to `years`.
  function yearMean(keys, field) {
    const byYear = new Map();
    for (const r of history) {
      if (!keys.has(r.market_key)) continue;
      const v = cleanZero(r[field]);
      if (v == null) continue;
      if (!byYear.has(r.year_)) byYear.set(r.year_, []);
      byYear.get(r.year_).push(v);
    }
    return years.map((y) => {
      const xs = byYear.get(y) || [];
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    });
  }
  const s30YearMean = (field) => yearMean(s30Keys, field);
  const p4YearMean = (field) => yearMean(p4Keys, field);

  // "This market" series for the active Market Performance filter. "market"
  // uses the whole-market history; the distance/vintage scopes aggregate
  // property_history (bed-weighted) across the matching subset of properties.
  function scopeSeries(field) {
    if (perfScope === "market") {
      return myHistory.map((r) => cleanZero(r[field]));
    }
    const lim = perfScope === "0.5mi" ? 0.5 : 1;     // 1mi and 1mi2015 share 1mi
    const minYear = perfScope === "1mi2015" ? 2015 : 0;
    const propKeys = new Set(
      PROPERTIES
        .filter((p) => p.milesToClosestCampus != null && p.milesToClosestCampus <= lim
          && (minYear === 0 || (p.yearBuilt || 0) >= minYear))
        .map((p) => p.property_key)
    );
    const byYear = new Map();  // year -> { sum, w } (bed-weighted)
    for (const r of (DATA.tables.property_history || [])) {
      if (!propKeys.has(r.property_key)) continue;
      const v = cleanZero(r[field]);
      const w = r.beds || 0;
      if (v == null || w <= 0) continue;
      const e = byYear.get(r.year_) || { sum: 0, w: 0 };
      e.sum += v * w; e.w += w;
      byYear.set(r.year_, e);
    }
    return years.map((y) => {
      const e = byYear.get(y);
      return e && e.w > 0 ? e.sum / e.w : null;
    });
  }

  function renderTimeSeries(canvasId, field, valueFmt, { transform = (v) => v, yMax = null } = {}) {
    const ctx = document.getElementById(canvasId);
    if (!ctx || !years.length) return;
    setPerfTitle(canvasId);
    const myData = scopeSeries(field).map((v) => v == null ? null : transform(v));
    const s30Data = s30YearMean(field).map((v) => v == null ? null : transform(v));
    const p4Data = p4YearMean(field).map((v) => v == null ? null : transform(v));
    if (perfCharts[canvasId]) perfCharts[canvasId].destroy();
    perfCharts[canvasId] = new Chart(ctx, {
      type: "bar",
      data: {
        labels: years.map(String),
        datasets: [
          { label: MARKET.anchor_university || "This market", data: myData, backgroundColor: PERF.anchorColor, borderRadius: 2,
            categoryPercentage: 0.78, barPercentage: 0.95 },
          { label: "Subtext-30 avg",                          data: s30Data, backgroundColor: PERF.benchColor, borderRadius: 2,
            categoryPercentage: 0.78, barPercentage: 0.95 },
          { label: "Power 4 avg",                             data: p4Data, backgroundColor: PERF.power4Color, borderRadius: 2,
            categoryPercentage: 0.78, barPercentage: 0.95 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y == null ? "-" : valueFmt(c.parsed.y)}` } },
          datalabels: {
            anchor: "end", align: "end", offset: 2, clip: false,
            font: { weight: 700, size: 10, family: "Pragmatica, sans-serif" },
            color: "#2b2825",
            formatter: (v) => v == null ? "" : valueFmt(v),
          },
        },
        layout: { padding: { top: 18, right: 6, left: 6, bottom: 0 } },
        scales: {
          x: { grid: { display: false }, border: { display: false },
               ticks: { font: { size: 11, weight: 700, family: "Pragmatica, sans-serif" }, color: "#2b2825" } },
          y: { display: true, beginAtZero: true, max: yMax,
               grid: { color: "#f5efde", drawTicks: false }, border: { display: false },
               ticks: { font: { size: 10, family: "Pragmatica, sans-serif" }, color: "#5a544f",
                        maxTicksLimit: 5, callback: (v) => valueFmt(v) } },
        },
      },
    });
  }

  renderTimeSeries("perf-rent",         "avg_rent_per_bed", (v) => fmtUsd(v));
  renderTimeSeries("perf-occupancy",    "occupancy",        (v) => `${(v * 100).toFixed(0)}%`, { yMax: 1 });
  renderTimeSeries("perf-prelease",     "prelease",         (v) => `${(v * 100).toFixed(0)}%`, { yMax: 1 });

  // Rent growth: compute YoY from consecutive years, drop the first year.
  const rentGrowthCtx = document.getElementById("perf-rent-growth");
  if (rentGrowthCtx && myHistory.length > 1) {
    setPerfTitle("perf-rent-growth");
    const myRentSeries = scopeSeries("avg_rent_per_bed");
    const s30RentSeries = s30YearMean("avg_rent_per_bed");
    const p4RentSeries = p4YearMean("avg_rent_per_bed");
    const growthYears = years.slice(1);
    const yoy = (series, i) => {
      const a = series[i + 1], b = series[i];
      return (a != null && b != null && b !== 0) ? (a - b) / b : null;
    };
    const myGrowth = growthYears.map((_, i) => yoy(myRentSeries, i));
    const s30Growth = growthYears.map((_, i) => yoy(s30RentSeries, i));
    const p4Growth = growthYears.map((_, i) => yoy(p4RentSeries, i));
    if (perfCharts[ "perf-rent-growth" ]) perfCharts["perf-rent-growth"].destroy();
    perfCharts["perf-rent-growth"] = new Chart(rentGrowthCtx, {
      type: "bar",
      data: {
        labels: growthYears.map(String),
        datasets: [
          { label: MARKET.anchor_university || "This market", data: myGrowth.map((v) => v == null ? null : v * 100),  backgroundColor: PERF.anchorColor, borderRadius: 2,
            categoryPercentage: 0.78, barPercentage: 0.95 },
          { label: "Subtext-30 avg",                          data: s30Growth.map((v) => v == null ? null : v * 100), backgroundColor: PERF.benchColor, borderRadius: 2,
            categoryPercentage: 0.78, barPercentage: 0.95 },
          { label: "Power 4 avg",                             data: p4Growth.map((v) => v == null ? null : v * 100), backgroundColor: PERF.power4Color, borderRadius: 2,
            categoryPercentage: 0.78, barPercentage: 0.95 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y == null ? "-" : c.parsed.y.toFixed(1) + "%"}` } },
          datalabels: {
            anchor: (c) => c.dataset.data[c.dataIndex] != null && c.dataset.data[c.dataIndex] >= 0 ? "end" : "start",
            align:  (c) => c.dataset.data[c.dataIndex] != null && c.dataset.data[c.dataIndex] >= 0 ? "end" : "start",
            offset: 2, clip: false,
            font: { weight: 700, size: 10, family: "Pragmatica, sans-serif" },
            color: "#2b2825",
            formatter: (v) => v == null ? "" : `${v.toFixed(0)}%`,
          },
        },
        layout: { padding: { top: 18, right: 6, left: 6, bottom: 18 } },
        scales: {
          x: { grid: { display: false }, border: { display: false },
               ticks: { font: { size: 11, weight: 700, family: "Pragmatica, sans-serif" }, color: "#2b2825" } },
          y: { display: true, suggestedMin: -5,
               grid: { color: "#f5efde", drawTicks: false }, border: { display: false },
               ticks: { font: { size: 10, family: "Pragmatica, sans-serif" }, color: "#5a544f",
                        maxTicksLimit: 6, callback: (v) => `${v}%` } },
        },
      },
    });
  }

}

// Market Performance distance/vintage filter. Re-renders the rent, growth,
// occupancy, and prelease charts against the chosen subset of the market.
function bindPerfScope() {
  const btns = document.querySelectorAll(".perf-scope-btn");
  btns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.scope;
      if (next === perfScope) return;
      perfScope = next;
      btns.forEach((b) => b.classList.toggle("active", b.dataset.scope === perfScope));
      renderPerformance();
    });
  });
}

/* ----- Helpers ----------------------------------------------- */

// Pin the sticky market header right below the (sticky) topbar by mirroring
// the topbar's rendered height into a CSS variable.
function syncTopbarHeight() {
  const tb = document.querySelector(".topbar");
  if (tb) document.documentElement.style.setProperty("--topbar-h", tb.offsetHeight + "px");
}

function showError(msg) {
  document.getElementById("market-loading").style.display = "none";
  const el = document.getElementById("market-error");
  el.style.display = "block";
  el.textContent = msg;
}

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
function fmtNum(v, digits = 1) {
  if (v == null || isNaN(v)) return "-";
  return Number(v).toFixed(digits);
}
function fmtYear(v) {
  if (v == null || isNaN(v) || v < 1800) return "-";
  return String(v);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function deltaSpan(v) {
  if (v == null) return `<span class="delta flat">-</span>`;
  const cls = v > 0.005 ? "up" : v < -0.005 ? "down" : "flat";
  const arr = v > 0.005 ? "▲" : v < -0.005 ? "▼" : "";
  return `<span class="delta ${cls}"><span class="arrow">${arr}</span>${fmtPct(v)}</span>`;
}

/* ----- Header + KPIs ----------------------------------------- */

function renderHeader() {
  document.getElementById("market-name").textContent = MARKET.anchor_university;
  const reportLink = document.getElementById("report-link");
  if (reportLink) {
    reportLink.href = `market-report.html?id=${MARKET.market_key}`;
    reportLink.style.display = "";
  }
  const region = MARKET.region ? ` · ${MARKET.region}` : "";
  document.getElementById("market-subtitle").textContent =
    `${MARKET.city || ""}, ${MARKET.state_abbr || ""}${region}`;

  document.title = `SubHouse - ${MARKET.anchor_university}`;

  if (MARKET.is_subtext30 === 1) {
    document.getElementById("s30-badge").style.display = "inline-flex";
  }
}

function renderKpis() {
  document.getElementById("kpi-beds").textContent = fmtInt(MARKET.existing_beds);
  document.getElementById("kpi-beds-sub").textContent =
    PROPERTIES.length > 0
      ? `across ${PROPERTIES.length} comp properties`
      : "purpose-built supply";

  document.getElementById("kpi-pipeline").textContent = fmtInt(MARKET.beds_pipeline_total);
  const pipParts = [];
  if (MARKET.beds_lease_up) pipParts.push(`${fmtInt(MARKET.beds_lease_up)} lease-up`);
  if (MARKET.beds_under_construction) pipParts.push(`${fmtInt(MARKET.beds_under_construction)} U/C`);
  if (MARKET.beds_planned) pipParts.push(`${fmtInt(MARKET.beds_planned)} planned`);
  document.getElementById("kpi-pipeline-sub").textContent = pipParts.join(" · ") || "-";

  document.getElementById("kpi-pen").textContent = fmtPct(MARKET.penetration_ratio);
  const bandColor = MARKET.penetration_ratio == null ? C.slate70
    : MARKET.penetration_ratio < 0.30 ? C.good
    : MARKET.penetration_ratio > 0.55 ? C.bad
    : C.warn;
  document.getElementById("kpi-pen").style.color = bandColor;
  const band = MARKET.penetration_ratio == null ? "-"
    : MARKET.penetration_ratio < 0.30 ? "Under-supplied"
    : MARKET.penetration_ratio > 0.55 ? "Over-supplied"
    : "Balanced";
  document.getElementById("kpi-pen-sub").textContent = band;

  // FTE = current full-time enrollment snapshot from MarketReports.
  // Total = sum of IPEDS totals across distinct institutions in this market.
  // Schools_Denormal can have multiple branch rows per institution (e.g.,
  // 10 Rutgers campus locations all rolling up to one IPEDS ID), so dedupe
  // by IPEDS ID before summing to avoid 10x inflation.
  const byIpeds = new Map();
  for (const c of CAMPUSES) {
    const key = c.ipeds_id ?? `school-${c.school_key}`;
    if (!byIpeds.has(key)) byIpeds.set(key, c.total_enrollment || 0);
  }
  const ipedsTotal = [...byIpeds.values()].reduce((s, n) => s + n, 0);

  // YoY preference order:
  //   1. fte_history.yoy_fte_growth (true FTE YoY from MarketReports history)
  //   2. enrollment_trend.yoy_change (total-enrollment YoY - proxy when FTE
  //      history isn't loaded)
  let yoyPct = null;
  let yoyLabel = "YoY";   // "FTE YoY" when real FTE; "total YoY" when proxy
  let trendYear = null;

  const fteHist = (DATA.tables.fte_history || [])
    .find((r) => r.market_key === MARKET.market_key);
  if (fteHist && fteHist.yoy_fte_growth != null) {
    yoyPct = fteHist.yoy_fte_growth;
    yoyLabel = "FTE YoY";
    trendYear = fteHist.current_snapshot
      ? new Date(fteHist.current_snapshot).getFullYear()
      : null;
  } else {
    const trendRows = (DATA.tables.enrollment_trend || [])
      .filter((r) => r.market_key === MARKET.market_key
                     && r.current_enrollment != null
                     && r.prev_year_enrollment != null);
    if (trendRows.length > 0) {
      const cur = trendRows.reduce((s, r) => s + r.current_enrollment, 0);
      const prev = trendRows.reduce((s, r) => s + r.prev_year_enrollment, 0);
      if (prev > 0) yoyPct = (cur - prev) / prev;
      yoyLabel = "total YoY";
      trendYear = Math.max(...trendRows.map((r) => r.current_year || 0)) || null;
    }
  }

  // Headline: FTE snapshot. Subline: total + YoY arrow.
  const enrEl = document.getElementById("kpi-enr");
  const enrSub = document.getElementById("kpi-enr-sub");
  enrEl.textContent = fmtInt(MARKET.enr_full_time);
  const parts = [];
  if (ipedsTotal > 0) parts.push(`${fmtInt(ipedsTotal)} total`);
  if (yoyPct != null) {
    const arrow = yoyPct > 0.001 ? "▲" : yoyPct < -0.001 ? "▼" : "";
    const cls = yoyPct > 0.001 ? "kpi-good" : yoyPct < -0.001 ? "kpi-bad" : "";
    const yoyStr = `<span class="${cls}">${arrow} ${(yoyPct * 100).toFixed(1)}% ${yoyLabel}</span>`;
    parts.push(trendYear ? `${yoyStr} (${trendYear})` : yoyStr);
  }
  enrSub.innerHTML = parts.length
    ? parts.join(" · ")
    : "IPEDS · no enrollment data";

  document.getElementById("kpi-rent").textContent = fmtUsd(MARKET.avg_rent_per_bed);
  document.getElementById("kpi-rent-sub").textContent = "bed-weighted average";

  // Rent YoY - pull from rent_yoy table; render in big KPI style with color
  const yoy = DATA.tables.rent_yoy.find((r) => r.market_key === MARKET.market_key);
  const yoyEl = document.getElementById("kpi-rent-yoy");
  if (yoy && yoy.yoy_rent_growth != null) {
    const v = yoy.yoy_rent_growth;
    const arrow = v > 0.005 ? "▲ " : v < -0.005 ? "▼ " : "";
    const tone = v > 0.005 ? "kpi-good" : v < -0.005 ? "kpi-bad" : "";
    yoyEl.className = `kpi-value ${tone}`;
    yoyEl.textContent = `${arrow}${fmtPct(v)}`;
    document.getElementById("kpi-rent-yoy-sub").textContent =
      `vs ${new Date(yoy.prior_snapshot).getFullYear()}`;
  } else {
    yoyEl.className = "kpi-value";
    yoyEl.textContent = "-";
    document.getElementById("kpi-rent-yoy-sub").textContent = "no prior-year data";
  }

  // Occupancy - bed-weighted from MarketReports
  const occEl = document.getElementById("kpi-occupancy");
  const occSub = document.getElementById("kpi-occupancy-sub");
  if (MARKET.occupancy != null) {
    const o = MARKET.occupancy;
    const occTone = o >= 0.92 ? "kpi-good" : o < 0.88 ? "kpi-bad" : "";
    occEl.className = `kpi-value ${occTone}`;
    occEl.textContent = fmtPct(o, 1);
    occSub.textContent = "bed-weighted";
  } else {
    occEl.className = "kpi-value";
    occEl.textContent = "-";
    occSub.textContent = "no occupancy on file";
  }

  // Pre-lease - latest cycle from MarketReports
  const preEl = document.getElementById("kpi-prelease");
  const preSub = document.getElementById("kpi-prelease-sub");
  if (MARKET.prelease != null) {
    const p = MARKET.prelease;
    const preTone = p >= 0.85 ? "kpi-good" : p < 0.65 ? "kpi-bad" : "";
    preEl.className = `kpi-value ${preTone}`;
    preEl.textContent = fmtPct(p, 1);
    preSub.textContent = "latest cycle";
  } else {
    preEl.className = "kpi-value";
    preEl.textContent = "-";
    preSub.textContent = "no prelease on file";
  }

  // Affluence - mean origin household income of incoming students.
  const aff = (DATA.tables.market_affluence || [])
    .find((r) => r.market_key === MARKET.market_key);
  const affEl = document.getElementById("kpi-affluence");
  const affSub = document.getElementById("kpi-affluence-sub");
  if (aff && aff.mean_origin_income != null && aff.n_students >= 100) {
    affEl.textContent = fmtUsd(aff.mean_origin_income);
    const hi = aff.pct_hiinc;
    affSub.textContent = hi != null
      ? `${fmtPct(hi)} from high-income tracts · ${aff.data_as_of}`
      : `mean origin income · ${aff.data_as_of}`;
  } else if (aff && aff.n_students > 0) {
    affEl.textContent = aff.mean_origin_income != null
      ? fmtUsd(aff.mean_origin_income) : "-";
    affSub.textContent = `low sample · n=${fmtInt(aff.n_students)}`;
  } else {
    affEl.textContent = "-";
    affSub.textContent = "no migration data";
  }
}

/* ----- Qualifier scorecard ----------------------------------- */

function renderQualifiers() {
  const all = DATA.tables.market_qualifiers || [];
  const q = all.find((r) => r.market_key === MARKET.market_key);
  const listEl = document.getElementById("qualifier-list");
  const summaryEl = document.getElementById("qualifier-summary");
  const badgeEl = document.getElementById("qualifier-score-badge");

  if (!q) {
    summaryEl.textContent = "No qualifier data for this market.";
    listEl.innerHTML = "";
    badgeEl.textContent = "-";
    return;
  }

  const pct = q.score_pct == null ? null : Math.round(q.score_pct * 100);
  badgeEl.textContent = pct == null ? "-" : `${pct}%`;
  badgeEl.dataset.tier =
    pct == null ? "na" : pct >= 80 ? "good" : pct >= 60 ? "warn" : "bad";

  const naCount = q.results.filter((r) => r.status === "na").length;
  // `passes` is a weighted credit total - rent_growth_3yr awards 1/3 per
  // trailing year that cleared 3%. Render as an integer when the total is
  // whole, otherwise to one decimal place.
  const passesNum = typeof q.passes === "number" ? q.passes : 0;
  const passesDisplay = Number.isInteger(passesNum) ? passesNum : passesNum.toFixed(1);
  summaryEl.textContent =
    `${passesDisplay} of ${q.evaluable} evaluable qualifiers passing` +
    (naCount > 0 ? ` · ${naCount} pending data` : "");

  listEl.innerHTML = q.results.map((r) => {
    // Binary scorecard: pass / fail / na. Older data may carry tier='warn'
    // - collapse anything that isn't a clean pass/na to 'fail'.
    let state = r.status || "fail";
    if (state !== "pass" && state !== "na") state = "fail";
    // Multi-year qualifiers (e.g. rent_growth_3yr) carry a per-year
    // breakdown - render each year as its own colored chip instead of one
    // aggregate value.
    let actualHtml;
    if (Array.isArray(r.breakdown) && r.breakdown.length) {
      actualHtml = r.breakdown.map((b) => {
        const cls = b.passed ? "pass" : "fail";
        return `<div class="qual-yoy-line qual-yoy-line-${cls}">
                  <span class="qual-yoy-line-year">${escapeHtml(b.label)}:</span>
                  <span class="qual-yoy-line-val">${escapeHtml(b.yoy_display)}</span>
                </div>`;
      }).join("");
    } else {
      actualHtml = `<span class="qual-actual-${state}">${escapeHtml(r.actual_display)}</span>`;
    }
    const icon = state === "pass" ? "&#10003;" : state === "na" ? "&ndash;" : "&#10007;";
    return `
      <li class="qual-row qual-${state}">
        <span class="qual-status" aria-hidden="true">${icon}</span>
        <div class="qual-label">${escapeHtml(r.label)}</div>
        <div class="qual-actual">${actualHtml}</div>
      </li>`;
  }).join("");
}

/* ----- Properties table -------------------------------------- */

function bindPropertySort() {
  // Both Market and Comps tabs have their own <table class="properties-table">
  // - each table's headers drive its own sort state.
  document.querySelectorAll(".properties-table thead th").forEach((th) => {
    th.addEventListener("click", () => {
      const tableId = th.closest("table").id;
      const sortState = propSortStates[tableId];
      if (!sortState) return;
      const col = th.dataset.sort;
      if (sortState.col === col) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState.col = col;
        sortState.dir = th.dataset.type === "num" ? "desc" : "asc";
      }
      renderProperties();
    });
  });
}

function renderProperties() {
  const compSet = PROPERTIES.filter((p) => p.is_comp_set);

  // First render defaults the selection to the standard comp set. After
  // that, user edits (including a deliberate Clear) persist across
  // re-renders such as sort changes.
  if (!compSelectionInit) {
    compSet.forEach((p) => compSelection.add(p.property_key));
    compSelectionInit = true;
  }

  renderPropertyTable({
    tableId: "properties-all",
    countId: "prop-count-all",
    rows: PROPERTIES,
    emptyMsg: "No purpose-built properties listed for this market.",
    label: "purpose-built propert",
  });
  // Every property in the market is selectable as a comp; the standard
  // comp set (walkable + built ≥2020 or top-rent) is just the default.
  renderPropertyTable({
    tableId: "properties-comps",
    countId: "prop-count-comps",
    rows: PROPERTIES,
    emptyMsg: "No purpose-built properties listed for this market.",
    label: "propert",
    selectable: true,
  });
  bindCompSelectButtons();
}

function updateCompCountLabel() {
  const countEl = document.getElementById("prop-count-comps");
  if (countEl) {
    countEl.textContent =
      `${compSelection.size} of ${PROPERTIES.length} properties selected as comps`;
  }
}

function bindCompSelectButtons() {
  document.querySelectorAll("[data-comps-select]").forEach((btn) => {
    if (btn.dataset.boundOnce) return;
    btn.dataset.boundOnce = "1";
    btn.addEventListener("click", () => {
      compSelection.clear();
      if (btn.dataset.compsSelect === "all") {
        PROPERTIES.forEach((p) => compSelection.add(p.property_key));
      } else if (btn.dataset.compsSelect === "default") {
        PROPERTIES.filter((p) => p.is_comp_set)
          .forEach((p) => compSelection.add(p.property_key));
      }
      renderProperties();
      renderCompCharts();
    });
  });
}

function renderPropertyTable({ tableId, countId, rows: source, emptyMsg, label, selectable = false }) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const sortState = propSortStates[tableId] || { col: "prelease", dir: "desc" };
  const tbody = table.querySelector("tbody");
  table.querySelectorAll("thead th").forEach((th) => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.sort === sortState.col) {
      th.classList.add(sortState.dir === "asc" ? "sorted-asc" : "sorted-desc");
    }
  });

  // Both tables land on 10 columns: the selectable comp table swaps the
  // Concessions column for the checkbox column.
  const colspan = 10;
  const countEl = document.getElementById(countId);
  if (source.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="empty-state">${emptyMsg}</td></tr>`;
    if (countEl) countEl.textContent = `0 ${label}ies`;
    return;
  }

  const { col, dir } = sortState;
  const sign = dir === "asc" ? 1 : -1;
  const rows = source.slice().sort((a, b) => {
    const av = a[col], bv = b[col];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number") return (av - bv) * sign;
    if (typeof av === "boolean") return (Number(av) - Number(bv)) * sign;
    return String(av).localeCompare(String(bv)) * sign;
  });

  tbody.innerHTML = rows.map((p) => {
    const checkboxCell = selectable
      ? `<td class="comp-select-cell">
           <input type="checkbox" class="comp-select-cb" data-pk="${p.property_key}"
             ${compSelection.has(p.property_key) ? "checked" : ""}>
         </td>`
      : "";
    return `
    <tr data-pk="${p.property_key}">
      ${checkboxCell}
      <td class="property-cell">
        ${escapeHtml(p.property_name || "(unnamed)")}${selectable && p.is_comp_set
          ? ' <span class="comp-pill" title="In the standard comp set">Comp</span>'
          : ""}
        <span class="city-state">${escapeHtml(p.street1 || "")}</span>
      </td>
      <td>${phasePill(p.phase)}</td>
      <td class="num">${fmtInt(p.beds)}</td>
      <td class="num">${fmtYear(p.yearBuilt)}</td>
      <td class="num">${fmtPct(p.occupancy)}</td>
      <td class="num">${fmtPct(p.prelease)}</td>
      <td class="num">${fmtUsd(p.avg_rent)}</td>
      <td class="num">${p.avg_rent_per_sf != null ? "$" + fmtNum(p.avg_rent_per_sf, 2) : "-"}</td>
      ${selectable ? "" : `<td>${p.hasConcessions ? '<span class="band-pill band-Balanced">Yes</span>' : '<span class="delta flat">-</span>'}</td>`}
      <td class="num">${fmtNum(p.milesToClosestCampus, 1)}</td>
    </tr>`;
  }).join("");

  if (selectable) {
    // Checkbox flips selection state and re-renders the charts. Clicking the
    // checkbox itself shouldn't trigger the row-navigate handler below.
    tbody.querySelectorAll(".comp-select-cb").forEach((cb) => {
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => {
        const pk = Number(cb.dataset.pk);
        if (cb.checked) compSelection.add(pk); else compSelection.delete(pk);
        updateCompCountLabel();
        // Highlight selected pin on the comps map and refresh charts.
        renderCompCharts();
      });
    });
  }

  // Row click → property detail page.
  // Shift-click keeps the previous behavior: pan + highlight in place.
  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      // Clicks on the checkbox cell shouldn't navigate.
      if (e.target.closest(".comp-select-cell")) return;
      const pk = Number(tr.dataset.pk);
      if (e.shiftKey) {
        // Pan the market map (Market tab only - the Comps tab map is the
        // static Comp Map Generator, which doesn't pan).
        const onComps = !!tr.closest('[data-panel="comps"]');
        const marker = onComps ? null : propertyMarkers.get(pk);
        if (marker && map) {
          map.setView(marker.getLatLng(), Math.max(map.getZoom(), 13), { animate: true });
          marker.openPopup();
        }
        document.querySelectorAll(".properties-table tr.selected").forEach((r) => r.classList.remove("selected"));
        tr.classList.add("selected");
        return;
      }
      window.location.href = `property.html?id=${pk}`;
    });
  });

  if (selectable) {
    updateCompCountLabel();
  } else if (countEl) {
    countEl.textContent = `${rows.length} ${label}${rows.length === 1 ? "y" : "ies"}`;
  }
}

/* ----- Tabs (Market / Comps) --------------------------------- */

function bindTabs() {
  const tabs = document.querySelectorAll(".market-tab");
  const panels = document.querySelectorAll(".market-tab-panel");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => {
        const on = t.dataset.tab === target;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      panels.forEach((p) => {
        p.hidden = p.dataset.panel !== target;
      });
      // Leaflet and Chart.js sniff their container's size on init, so a
      // chart created while its tab is hidden renders at 0×0. Lazy-init or
      // invalidateSize whenever a tab becomes visible.
      if (target === "market") {
        if (map) map.invalidateSize();
      } else if (target === "comps") {
        renderCompCharts();
      } else if (target === "pipeline") {
        renderPipeline();
      } else if (target === "student-migration") {
        renderStudentMigrationTab();
      } else if (target === "shadow-market") {
        renderShadowMarketTab();
      } else if (target === "university") {
        renderUniversityTab();
      }
    });
  });

  // Deep link: market.html?id=N#comps or #university opens that tab directly.
  const hash = location.hash.replace(/^#/, "");
  const initial = [...tabs].find((t) => t.dataset.tab === hash);
  if (initial && hash !== "market") initial.click();
}

function bindShadowMarketControls() {
  const metric = document.getElementById("shadow-market-metric");
  if (metric) metric.addEventListener("change", renderShadowMarketMap);
}

/* ----- Shadow Market Analysis tab ---------------------------- */

const SHADOW_MARKET_METRICS = {
  shadow_pop: {
    label: "Census shadow-population distribution",
    description: "Census block-group proxy used to show the relative neighborhood distribution",
  },
  shadow_hhs: {
    label: "Census shadow households",
    description: "Renter households age 15–24 adjusted to sub-50-unit inventory",
  },
  renter_15_24: {
    label: "Renter households age 15–24",
    description: "Raw ACS renter households with a householder age 15–24",
  },
  renter_units_sub50: {
    label: "Sub-50 renter inventory",
    description: "Census renter units in buildings with fewer than 50 units",
  },
};

const SHADOW_RING_COLORS = ["#a95818", "#c79830", "#16352e", "#5a544f"];

function positionShadowMarketTooltip(layer) {
  if (!shadowMarketMap || !layer) return;
  const tooltip = layer.getTooltip();
  if (!tooltip) return;

  const point = shadowMarketMap.latLngToContainerPoint(layer.getLatLng());
  const mapSize = shadowMarketMap.getSize();
  const verticalGuard = 175;
  let direction;
  if (point.y < verticalGuard) {
    direction = "bottom";
  } else if (point.y > mapSize.y - verticalGuard) {
    direction = "top";
  } else {
    direction = point.x < mapSize.x / 2 ? "right" : "left";
  }
  tooltip.options.direction = direction;
  tooltip.options.offset = L.point(
    direction === "top" || direction === "bottom" ? 0 : 10,
    direction === "top" || direction === "bottom" ? 10 : 0,
  );
  tooltip.update();
  requestAnimationFrame(() => {
    const element = tooltip.getElement();
    if (!element) return;
    const mapRect = shadowMarketMap.getContainer().getBoundingClientRect();
    const tooltipRect = element.getBoundingClientRect();
    const padding = 8;
    let dx = 0;
    let dy = 0;
    if (tooltipRect.left < mapRect.left + padding) {
      dx = mapRect.left + padding - tooltipRect.left;
    } else if (tooltipRect.right > mapRect.right - padding) {
      dx = mapRect.right - padding - tooltipRect.right;
    }
    if (tooltipRect.top < mapRect.top + padding) {
      dy = mapRect.top + padding - tooltipRect.top;
    } else if (tooltipRect.bottom > mapRect.bottom - padding) {
      dy = mapRect.bottom - padding - tooltipRect.bottom;
    }
    if (dx || dy) {
      const currentPosition = L.DomUtil.getPosition(element);
      if (currentPosition) {
        L.DomUtil.setPosition(
          element,
          currentPosition.add(L.point(dx, dy)),
        );
      }
    }
  });
}

async function loadShadowMarketBoundary() {
  if (shadowMarketBoundaryLoaded) return shadowMarketBoundaryData;
  shadowMarketBoundaryLoaded = true;
  try {
    const response = await fetch(
      `assets/campus-boundaries/${MARKET.market_key}.geojson`,
      { cache: "no-cache" },
    );
    if (response.ok) shadowMarketBoundaryData = await response.json();
  } catch {
    shadowMarketBoundaryData = null;
  }
  return shadowMarketBoundaryData;
}

async function renderShadowMarketTab() {
  if (shadowMarketData) {
    if (shadowMarketMap) setTimeout(() => shadowMarketMap.invalidateSize(), 0);
    return;
  }
  if (shadowMarketLoadPromise) return shadowMarketLoadPromise;

  const loading = document.getElementById("shadow-market-loading");
  const content = document.getElementById("shadow-market-content");
  const empty = document.getElementById("shadow-market-empty");
  loading.hidden = false;
  content.hidden = true;
  empty.hidden = true;

  shadowMarketLoadPromise = (async () => {
    try {
      const response = await fetch(
        `assets/shadow-market/${MARKET.market_key}.json`,
        { cache: "no-cache" },
      );
      if (response.status === 404) {
        loading.hidden = true;
        empty.hidden = false;
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json();
      if (Number(payload.market_key) !== Number(MARKET.market_key)) {
        throw new Error("Market key does not match the current dashboard market");
      }
      shadowMarketData = payload;
      await loadShadowMarketBoundary();
      renderShadowMarketSummary();
      loading.hidden = true;
      content.hidden = false;
      renderShadowMarketMap();
    } catch (error) {
      loading.hidden = true;
      empty.hidden = false;
      empty.textContent = `Couldn't load shadow-market analysis — ${error.message}`;
    } finally {
      shadowMarketLoadPromise = null;
    }
  })();
  return shadowMarketLoadPromise;
}

function renderShadowMarketSummary() {
  const data = shadowMarketData;
  const official = data.official;
  const total = official.total;
  document.getElementById("shadow-kpi-pop").textContent = fmtInt(total.shadow_pop);
  document.getElementById("shadow-kpi-pop-sub").textContent =
    `approved ${official.college_age} estimate · ACS ${data.year}`;
  document.getElementById("shadow-kpi-buildings").textContent = fmtInt(total.buildings);
  document.getElementById("shadow-kpi-buildings-sub").textContent =
    `${fmtInt(total.costar_beds)} beds · 5–49-unit multifamily`;
  document.getElementById("shadow-kpi-costar-units").textContent = fmtInt(total.costar_units);
  document.getElementById("shadow-kpi-census-units").textContent = fmtInt(total.census_2to4_units);
  document.getElementById("shadow-market-summary").textContent =
    `${data.anchor_university} · CoStar + Census · ACS ${data.year} · methodology v${official.methodology_version}`;

  const body = document.getElementById("shadow-market-rings");
  body.innerHTML = official.ring_labels.map((label) => {
    const ring = official.rings[label] || {};
    return `<tr>
      <td>${escapeHtml(label.replace("mi", " mi"))}</td>
      <td>${fmtInt(ring.buildings)}</td>
      <td>${fmtInt(ring.costar_units)}</td>
      <td>${fmtInt(ring.census_2to4_units)}</td>
      <td>${fmtInt(ring.total_units)}</td>
      <td>${fmtInt(ring.est_pop)}</td>
      <td>${fmtInt(ring.shadow_pop)}</td>
    </tr>`;
  }).join("");
}

function renderShadowMarketMap() {
  if (!shadowMarketData || typeof L === "undefined") return;

  const metricKey = document.getElementById("shadow-market-metric").value;
  const metric = SHADOW_MARKET_METRICS[metricKey];
  const data = shadowMarketData;
  const official = data.official;
  const mapData = data.distribution_proxy;
  const mapPoints = mapData.points;

  if (!shadowMarketMap) {
    shadowMarketMap = L.map("shadow-market-map", {
      center: Object.values(official.campuses)[0],
      zoom: 13,
      scrollWheelZoom: true,
      minZoom: 8,
      worldCopyJump: false,
      maxBounds: [[-85, -180], [85, 180]],
      maxBoundsViscosity: 1,
    });

    const baseLayers = {
      "Street": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
        maxZoom: 19,
        noWrap: true,
      }),
      "Satellite": L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { attribution: "Tiles © Esri, Maxar, Earthstar Geographics", maxZoom: 19, noWrap: true },
      ),
      "Light": L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        { attribution: "© OSM · © CARTO", subdomains: "abcd", maxZoom: 19, noWrap: true },
      ),
    };
    baseLayers.Street.addTo(shadowMarketMap);
    L.control.layers(baseLayers, null, {
      position: "topright",
      collapsed: true,
    }).addTo(shadowMarketMap);
    addFullscreenControl(shadowMarketMap);
    shadowMarketOverlay = L.layerGroup().addTo(shadowMarketMap);
    shadowMarketMap.createPane("shadowCampusBoundaryPane");
    const boundaryPane = shadowMarketMap.getPane("shadowCampusBoundaryPane");
    boundaryPane.style.zIndex = 425;
    boundaryPane.style.pointerEvents = "none";
  } else {
    shadowMarketOverlay.clearLayers();
  }

  const bounds = L.latLngBounds();
  Object.entries(official.campuses).forEach(([campusName, coords]) => {
    [...official.ring_miles].reverse().forEach((miles, reverseIndex) => {
      const index = official.ring_miles.length - 1 - reverseIndex;
      const color = SHADOW_RING_COLORS[index % SHADOW_RING_COLORS.length];
      const circle = L.circle(coords, {
        radius: miles * 1609.34,
        color,
        fillColor: color,
        fillOpacity: 0.025,
        opacity: 0.8,
        weight: 2,
      }).bindTooltip(`${official.ring_labels[index]} from ${campusName}`);
      shadowMarketOverlay.addLayer(circle);
      bounds.extend(circle.getBounds());
    });
  });

  const positivePoints = mapPoints.filter((point) => Number(point[metricKey]) > 0);
  const sortedValues = positivePoints
    .map((point) => Number(point[metricKey]))
    .sort((a, b) => a - b);
  const displayCapIndex = Math.max(0, Math.ceil(sortedValues.length * 0.90) - 1);
  const displayCap = sortedValues[displayCapIndex] || 1;
  const heatPoints = positivePoints.map((point) => [
    point.lat,
    point.lon,
    Math.min(1, Math.pow(Number(point[metricKey]) / displayCap, 0.42)),
  ]);

  if (typeof L.heatLayer === "function" && heatPoints.length) {
    shadowMarketOverlay.addLayer(L.heatLayer(heatPoints, {
      radius: 46,
      blur: 22,
      maxZoom: 16,
      minOpacity: 0.50,
      max: 1,
      gradient: {
        0.08: "#1d4ed8",
        0.25: "#06b6d4",
        0.45: "#84cc16",
        0.65: "#facc15",
        0.82: "#f97316",
        1.0: "#dc2626",
      },
    }));
  }

  if (shadowMarketBoundaryData) {
    const boundaryLayer = L.geoJSON(shadowMarketBoundaryData, {
      pane: "shadowCampusBoundaryPane",
      style: {
        color: "#d32f2f",
        weight: 2,
        opacity: 0.95,
        fillColor: "#d32f2f",
        fillOpacity: 0.18,
      },
      interactive: false,
    });
    shadowMarketOverlay.addLayer(boundaryLayer);
  }

  positivePoints.forEach((point) => {
    const tooltip = `
      <div class="map-popup">
        <div class="map-popup-head">
          <div class="map-popup-eyebrow">Census block-group distribution</div>
          <div class="map-popup-title">${escapeHtml(point.name)}</div>
        </div>
        <div class="map-popup-body">
          <div class="map-popup-row">
            <span class="map-popup-row-label">${escapeHtml(metric.label)}</span>
            <span class="map-popup-row-value">${fmtInt(point[metricKey])}</span>
          </div>
          <div class="map-popup-row">
            <span class="map-popup-row-label">Shadow population</span>
            <span class="map-popup-row-value">${fmtInt(point.shadow_pop)}</span>
          </div>
          <div class="map-popup-row">
            <span class="map-popup-row-label">Renters age 15–24</span>
            <span class="map-popup-row-value">${fmtInt(point.renter_15_24)}</span>
          </div>
          <div class="map-popup-row">
            <span class="map-popup-row-label">Sub-50 renter units</span>
            <span class="map-popup-row-value">${fmtInt(point.renter_units_sub50)}</span>
          </div>
          <div class="map-popup-address">${escapeHtml(point.ring)} · ${fmtNum(point.distance_mi, 2)} mi to campus</div>
        </div>
      </div>`;
    const pointMarker = L.circleMarker([point.lat, point.lon], {
      radius: 6,
      color: C.slate,
      opacity: 0.28,
      fillColor: "#ffffff",
      fillOpacity: 0.08,
      weight: 1,
    }).bindTooltip(tooltip, {
      className: "market-popup-wrapper shadow-market-tooltip",
      direction: "auto",
      offset: [10, 0],
      sticky: false,
      opacity: 1,
    });
    pointMarker.on("mouseover", () => positionShadowMarketTooltip(pointMarker));
    shadowMarketOverlay.addLayer(pointMarker);
  });

  Object.entries(official.campuses).forEach(([campusName, coords]) => {
    const marker = L.marker(coords, {
      icon: campusMarkerIcon(true, MARKET.market_key, campusName),
      zIndexOffset: 1000,
    }).bindPopup(`<div class="map-popup">
      <div class="map-popup-head">
        <div class="map-popup-eyebrow">Anchor university</div>
        <div class="map-popup-title">${escapeHtml(campusName)}</div>
      </div>
    </div>`);
    shadowMarketOverlay.addLayer(marker);
    bounds.extend(coords);
  });

  if (bounds.isValid()) {
    shadowMarketMap.fitBounds(bounds, { padding: [35, 35], maxZoom: 14 });
  }
  setTimeout(() => shadowMarketMap.invalidateSize(), 0);

  const ringLegend = official.ring_labels.map((label, index) => `
    <span class="shadow-market-ring-key">
      <span class="shadow-market-ring-swatch" style="background:${SHADOW_RING_COLORS[index % SHADOW_RING_COLORS.length]}"></span>
      ${escapeHtml(label)}
    </span>`).join("");
  document.getElementById("shadow-market-legend").innerHTML = `
    <strong>${escapeHtml(metric.label)}:</strong> ${fmtInt(mapData.total[metricKey])}
    across ${fmtInt(mapData.total.block_groups)} Census block groups (ACS ${data.year})<br>
    <strong>Visualization only:</strong> Census distribution proxy. Official KPI and
    ring totals use the approved CoStar 5–49 + Census 2–4 methodology.<br>
    <strong>Heat:</strong> Low <span class="shadow-market-gradient"></span> High
    (90th percentile display cap: ${fmtInt(displayCap)})<br>
    <strong>Definition:</strong> ${escapeHtml(metric.description)}<br>
    <strong>Distance rings:</strong> ${ringLegend}`;
}

function bindPipelineToggle() {
  document.querySelectorAll(".pipeline-scope-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.dist === pipelineDistance) return;
      pipelineDistance = btn.dataset.dist;
      renderPipeline();
    });
  });
}

/* ----- Pipeline tab ------------------------------------------ */
// Four panels mirroring the Development Pipeline view: total pipeline beds by
// phase (doughnut), the project list, deliveries by year, and same-store vs
// new-delivery rate growth. Scoped to the current market. Charts lazy-render
// on tab show (a canvas sized while hidden renders at 0x0).

const PIPE_PHASE_LABELS = {
  "planned": "Planned",
  "under construction": "Under Construction",
  "lease up": "Lease Up",
  "stable": "Stabilized",
};
const PIPE_COLORS = {
  planned: "#b6b1ab",            // slate30
  under_construction: "#a95818", // rust
  lease_up: "#16352e",           // everest
  delivered: "#7fb0a4",          // light teal - already delivered
  projected: "#16352e",          // everest - not yet delivered
  newdeliv: "#a95818",           // rust - new-delivery rent line
};

function bedWeightedRent(rows) {
  let num = 0, den = 0;
  rows.forEach((r) => {
    if (r.avg_rent_per_bed && r.beds) { num += r.avg_rent_per_bed * r.beds; den += r.beds; }
  });
  return den ? num / den : null;
}

// Keep only properties within the active campus-distance band. Properties
// missing a distance are dropped from the ½-mi and 1-mi bands, kept in Total.
function withinDistance(props) {
  if (pipelineDistance === "all") return props;
  const lim = parseFloat(pipelineDistance);
  return props.filter((p) => p.milesToClosestCampus != null
    && p.milesToClosestCampus <= lim);
}

function renderPipeline() {
  if (typeof Chart === "undefined") return;

  // Reflect the active distance band on the toggle and scope every panel to
  // properties within that radius of campus.
  document.querySelectorAll(".pipeline-scope-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.dist === pipelineDistance));
  const distLabel = pipelineDistance === "all" ? "market-wide"
    : pipelineDistance === "0.5" ? "within ½ mi of campus" : "within 1 mi of campus";

  // Reflect the active distance band in each panel title, e.g.
  // "Total Pipeline Beds - 1 Mile". The market-wide default keeps the base.
  const distSuffix = pipelineDistance === "all" ? ""
    : pipelineDistance === "0.5" ? "0.5 Mile" : "1 Mile";
  const setPipeTitle = (id, base) => {
    const el = document.getElementById(id);
    if (el) el.textContent = distSuffix ? `${base} - ${distSuffix}` : base;
  };
  setPipeTitle("pipe-totalbeds-title", "Total Pipeline Beds");
  setPipeTitle("pipe-projects-title", "New Projects");
  setPipeTitle("pipe-deliveries-title", "Deliveries Over Time");
  setPipeTitle("pipe-rate-title", "Same-Store Rate Growth");

  const scoped = withinDistance(PROPERTIES);

  // Pipeline projects (within band) - the single source for every panel so
  // the doughnut total always equals the listed projects. (The market-level
  // pipeline_beds aggregate on the Market tab can run higher because it
  // includes planned beds that have no individual property record yet.)
  const pipePhases = ["under construction", "lease up", "planned"];
  const projects = scoped
    .filter((p) => pipePhases.includes(p.phase))
    .sort((a, b) => (a.yearBuilt || 9999) - (b.yearBuilt || 9999)
      || (b.beds || 0) - (a.beds || 0));

  // All-band pipeline-bed totals for the at-a-glance comparison in the summary.
  const bandBeds = (lim) => PROPERTIES
    .filter((p) => pipePhases.includes(p.phase)
      && (lim == null || (p.milesToClosestCampus != null && p.milesToClosestCampus <= lim)))
    .reduce((s, p) => s + (p.beds || 0), 0);

  // ---- Panel 1: total pipeline beds by phase (doughnut) -----------------
  const sumByPhase = (phase) =>
    projects.filter((p) => p.phase === phase).reduce((s, p) => s + (p.beds || 0), 0);
  const planned = sumByPhase("planned");
  const uc = sumByPhase("under construction");
  const lu = sumByPhase("lease up");
  const totalPipe = planned + uc + lu;

  const summary = document.getElementById("pipeline-summary");
  if (summary) {
    const totalMarket = bandBeds(null);
    summary.textContent = totalMarket > 0
      ? `Pipeline beds by proximity to campus: ${fmtInt(bandBeds(0.5))} within ½ mi · ${fmtInt(bandBeds(1.0))} within 1 mi · ${fmtInt(totalMarket)} market-wide. Showing ${distLabel}.`
      : "No planned, under-construction, or lease-up beds on record for this market.";
  }

  const centerText = {
    id: "pipeCenterText",
    afterDraw(chart) {
      if (chart.canvas.id !== "pipe-totalbeds") return;
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const cx = (chartArea.left + chartArea.right) / 2;
      const cy = (chartArea.top + chartArea.bottom) / 2;
      ctx.save();
      ctx.textAlign = "center";
      ctx.fillStyle = "#837c75";
      ctx.font = "600 11px Pragmatica, sans-serif";
      ctx.fillText("Total Beds", cx, cy - 10);
      ctx.fillStyle = "#16352e";
      ctx.font = "700 26px 'Mencken Std', Georgia, serif";
      ctx.fillText(fmtInt(totalPipe), cx, cy + 16);
      ctx.restore();
    },
  };

  if (pipeCharts["pipe-totalbeds"]) pipeCharts["pipe-totalbeds"].destroy();
  const tbCanvas = document.getElementById("pipe-totalbeds");
  if (tbCanvas) {
    pipeCharts["pipe-totalbeds"] = new Chart(tbCanvas.getContext("2d"), {
      type: "doughnut",
      data: {
        labels: [
          `Lease Up (${fmtInt(lu)})`,
          `Under Construction (${fmtInt(uc)})`,
          `Planned (${fmtInt(planned)})`,
        ],
        datasets: [{
          data: totalPipe > 0 ? [lu, uc, planned] : [],
          backgroundColor: [PIPE_COLORS.lease_up, PIPE_COLORS.under_construction, PIPE_COLORS.planned],
          borderColor: "#fff",
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "64%",
        layout: { padding: 6 },
        plugins: {
          legend: { position: "bottom",
            labels: { font: { size: 11, family: "Pragmatica, sans-serif" }, color: "#2b2825",
                      boxWidth: 12, boxHeight: 12, padding: 9 } },
          tooltip: { callbacks: { label: (c) => `${c.label.replace(/\s*\(.*\)/, "")}: ${fmtInt(c.parsed)} beds` } },
          datalabels: {
            color: "#fff", font: { weight: 700, size: 11, family: "Pragmatica, sans-serif" },
            formatter: (v) => (v && totalPipe && v / totalPipe >= 0.06) ? fmtInt(v) : "",
          },
        },
      },
      plugins: [centerText],
    });
  }

  // ---- Panel 2: New Projects table --------------------------------------
  const projTable = document.getElementById("pipe-projects");
  if (projTable) {
    if (projects.length === 0) {
      projTable.innerHTML = `<tbody><tr><td>No pipeline projects on record for this market.</td></tr></tbody>`;
    } else {
      const head = `<thead><tr><th class="property-cell">Property</th><th class="property-cell">Phase</th>`
        + `<th>Completion</th><th>Beds</th></tr></thead>`;
      const body = projects.map((p) =>
        `<tr><td class="property-cell">${p.property_name}</td>`
        + `<td class="property-cell">${PIPE_PHASE_LABELS[p.phase] || p.phase}</td>`
        + `<td>${p.yearBuilt || "-"}</td>`
        + `<td>${p.beds ? fmtInt(p.beds) : "-"}</td></tr>`).join("");
      projTable.innerHTML = head + `<tbody>${body}</tbody>`;
    }
  }

  // ---- Panel 3: Deliveries Over Time (beds by year built) ---------------
  const delivered = {}, projected = {};
  scoped.forEach((p) => {
    const yb = p.yearBuilt, b = p.beds || 0;
    if (!yb || !b) return;
    const bucket = ["stable", "lease up"].includes(p.phase) ? delivered : projected;
    bucket[yb] = (bucket[yb] || 0) + b;
  });
  const years = [...new Set([...Object.keys(delivered), ...Object.keys(projected)].map(Number))]
    .sort((a, b) => a - b);
  if (pipeCharts["pipe-deliveries"]) pipeCharts["pipe-deliveries"].destroy();
  const delCanvas = document.getElementById("pipe-deliveries");
  if (delCanvas) {
    pipeCharts["pipe-deliveries"] = new Chart(delCanvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: years,
        datasets: [
          { label: "Beds Delivered", backgroundColor: PIPE_COLORS.delivered,
            data: years.map((y) => delivered[y] || 0), borderRadius: 2 },
          { label: "Projected Deliveries", backgroundColor: PIPE_COLORS.projected,
            data: years.map((y) => projected[y] || 0), borderRadius: 2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom",
            labels: { font: { size: 11, family: "Pragmatica, sans-serif" }, color: "#2b2825",
                      boxWidth: 12, boxHeight: 12, padding: 10 } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtInt(c.parsed.y)} beds` } },
          datalabels: { display: false },
        },
        scales: {
          x: { stacked: true, grid: { display: false, drawBorder: false }, border: { display: false },
               ticks: { color: "#5a544f", font: { size: 11 } } },
          y: { stacked: true, beginAtZero: true, grid: { color: "#f5efde", drawTicks: false },
               border: { display: false }, ticks: { color: "#5a544f", font: { size: 11 },
               callback: (v) => fmtInt(v) } },
        },
      },
    });
  }

  // ---- Panel 4: Same-Store Rate Growth (annual, bed-weighted) -----------
  const hist = DATA.tables.property_history || [];
  const stableKeys = new Set(scoped.filter((p) => p.phase === "stable").map((p) => p.property_key));
  const newKeys = new Set(scoped.filter((p) => p.phase === "lease up").map((p) => p.property_key));
  const histYears = [...new Set(hist
    .filter((r) => stableKeys.has(r.property_key) || newKeys.has(r.property_key))
    .map((r) => r.year_))].sort((a, b) => a - b);
  const rentBy = (keys) => histYears.map((y) =>
    bedWeightedRent(hist.filter((r) => r.year_ === y && keys.has(r.property_key))));
  const stableRents = rentBy(stableKeys);
  const newRents = rentBy(newKeys);
  const hasNew = newRents.some((v) => v != null);

  const rateDatasets = [{
    label: "Stabilized Properties", data: stableRents,
    borderColor: PIPE_COLORS.lease_up, backgroundColor: PIPE_COLORS.lease_up,
    borderWidth: 2.5, pointRadius: 3, tension: 0.25, spanGaps: true,
  }];
  if (hasNew) rateDatasets.push({
    label: "New Deliveries", data: newRents,
    borderColor: PIPE_COLORS.newdeliv, backgroundColor: PIPE_COLORS.newdeliv,
    borderWidth: 2.5, pointRadius: 3, tension: 0.25, spanGaps: true,
  });

  if (pipeCharts["pipe-rate"]) pipeCharts["pipe-rate"].destroy();
  const rateCanvas = document.getElementById("pipe-rate");
  if (rateCanvas) {
    pipeCharts["pipe-rate"] = new Chart(rateCanvas.getContext("2d"), {
      type: "line",
      data: { labels: histYears, datasets: rateDatasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom",
            labels: { font: { size: 11, family: "Pragmatica, sans-serif" }, color: "#2b2825",
                      boxWidth: 18, boxHeight: 2, padding: 10, usePointStyle: true } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y == null ? "-" : "$" + fmtInt(c.parsed.y)}` } },
          datalabels: { display: false },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: "#5a544f", font: { size: 11 } } },
          y: { beginAtZero: false, grid: { color: "#f5efde", drawTicks: false }, border: { display: false },
               ticks: { color: "#5a544f", font: { size: 11 }, callback: (v) => "$" + fmtInt(v) } },
        },
        interaction: { mode: "index", intersect: false },
      },
    });
  }
}

/* ----- Map (Leaflet) ----------------------------------------- */

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

// Property icon: SHAPE + COLOR by phase. Each phase has its own brand-palette
// color and shape so they're identifiable at a glance and in greyscale.
const PHASE_STYLES = {
  "stable":             { shape: "diamond",  color: "#16352e", label: "Stabilized" },        // Everest Green
  "lease up":           { shape: "square",   color: "#c1d100", label: "Lease Up" },          // Lime Green
  "under construction": { shape: "triangle", color: "#a95818", label: "Under Construction" },// Birch (rust)
  "planned":            { shape: "pentagon", color: "#5a544f", label: "Planned" },           // Slate-70
};
const PHASE_STYLE_DEFAULT = { shape: "circle", color: "#b6b1ab", label: "Unknown" };

function phaseStyle(phase) {
  return PHASE_STYLES[(phase || "").toLowerCase()] || PHASE_STYLE_DEFAULT;
}

function shapeSvg(shape, fill, size = 16) {
  const stroke = "white";
  const sw = 1.5;
  const half = size / 2;
  switch (shape) {
    case "diamond":
      return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><polygon points="8,1 15,8 8,15 1,8" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
    case "square":
      return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><rect x="2.5" y="2.5" width="11" height="11" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
    case "triangle":
      return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><polygon points="8,1.5 14.5,14 1.5,14" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
    case "pentagon":
      return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><polygon points="8,1.5 14.5,6.5 12,14.5 4,14.5 1.5,6.5" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
    case "circle":
    default:
      return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><circle cx="8" cy="8" r="6" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
  }
}

const PROP_PIN_SIZE = 22;

function propMarkerIcon(p) {
  const s = phaseStyle(p.phase);
  return L.divIcon({
    className: "leaflet-prop-pin",
    html: shapeSvg(s.shape, s.color, PROP_PIN_SIZE),
    iconSize: [PROP_PIN_SIZE, PROP_PIN_SIZE],
    iconAnchor: [PROP_PIN_SIZE / 2, PROP_PIN_SIZE / 2],
  });
}

function renderLegend() {
  // Each .legend-shape has data-phase (e.g., "stable", "lease up"). Render the
  // matching shape + color so the legend stays in sync with the map markers.
  document.querySelectorAll(".legend-shape").forEach((el) => {
    const phase = el.dataset.phase || "";
    const s = phaseStyle(phase);
    el.innerHTML = shapeSvg(s.shape, s.color, 12);
  });
}

function phasePill(phase) {
  if (!phase) return `<span class="phase-pill phase-unknown">-</span>`;
  const s = phaseStyle(phase);
  const slug = (phase || "").toLowerCase().replace(/\s+/g, "-");
  return `<span class="phase-pill phase-${slug}" style="--phase-color:${s.color}">
    <span class="phase-dot" style="background:${s.color}"></span>
    ${escapeHtml(s.label)}
  </span>`;
}

function campusMarkerIcon(isAnchor, marketKey, universityName = "University") {
  // Anchor campuses use the dashboard logo when available and a readable
  // university-name badge otherwise. Non-anchor campuses use the SVG icon.
  if (isAnchor && marketKey != null && LOGOS.has(marketKey)) {
    const file = LOGOS.get(marketKey);
    const url = `assets/campus-logos/${encodeURIComponent(file)}`;
    // Inline !important styles to beat Leaflet's '.leaflet-container img'
    // default which forces max-width: none.
    const imgStyle = [
      "display:block",
      "max-width:80px !important",
      "max-height:32px !important",
      "width:auto !important",
      "height:auto !important",
      "object-fit:contain",
    ].join(";");
    return L.divIcon({
      className: "leaflet-logo-pin",
      html: `<div class="logo-pin-bubble"><img src="${url}" alt="" style="${imgStyle}"></div>`,
      iconSize: [120, 56],
      iconAnchor: [60, 56],
    });
  }
  if (isAnchor) {
    return L.divIcon({
      className: "leaflet-campus-label-pin",
      html: `<div class="campus-label-bubble">${escapeHtml(universityName)}</div>`,
      iconSize: [170, 64],
      iconAnchor: [85, 64],
    });
  }
  return L.divIcon({
    className: "leaflet-campus-pin",
    html: `<div class="pin-campus-svg ${isAnchor ? "anchor" : ""}">
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M12 2L3 7l9 5 9-5-9-5z" fill="${isAnchor ? C.lime : C.slate}"/>
        <path d="M3 17l9 5 9-5M3 12l9 5 9-5" stroke="${isAnchor ? C.lime : C.slate}" stroke-width="1.5" fill="none"/>
      </svg></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 22],
  });
}

async function renderMap() {
  map = await buildMap({
    containerId: "map",
    propertyFilter: () => true,
    markerStore: propertyMarkers,
  });
}

async function buildMap({ containerId, propertyFilter, markerStore }) {
  const container = document.getElementById(containerId);
  if (!container) return null;
  if (typeof L === "undefined") {
    container.innerHTML = `<div class="empty-state">Map library failed to load.</div>`;
    return null;
  }

  const propsWithCoords = PROPERTIES.filter(
    (p) => p.latitude != null && p.longitude != null && propertyFilter(p),
  );
  const campusByLocation = new Map();
  CAMPUSES.filter(
    (c) => c.campus_lat != null && c.campus_lng != null,
  ).forEach((campus) => {
    const key = [
      campus.school_key,
      campus.university_name,
      campus.campus_lat,
      campus.campus_lng,
    ].join("|");
    const existing = campusByLocation.get(key);
    if (
      !existing
      || Number(campus.enrollment_year || 0) > Number(existing.enrollment_year || 0)
    ) {
      campusByLocation.set(key, campus);
    }
  });
  const allCampuses = [...campusByLocation.values()];

  if (propsWithCoords.length === 0 && allCampuses.length === 0) {
    container.innerHTML = `<div class="empty-state">No geocoded properties or campuses for this market.</div>`;
    return null;
  }

  const anchor = allCampuses.find((c) => c.university_name === MARKET.anchor_university)
              || allCampuses[0];
  const startLat = anchor ? anchor.campus_lat : propsWithCoords[0].latitude;
  const startLng = anchor ? anchor.campus_lng : propsWithCoords[0].longitude;

  const mapInst = L.map(containerId, {
    center: [startLat, startLng],
    zoom: 12,
    scrollWheelZoom: true,
    minZoom: 8,             // keep the market area in view; no tile-repeat
    worldCopyJump: false,
    maxBounds: [[-85, -180], [85, 180]],
    maxBoundsViscosity: 1,
  });

  // Multiple basemaps with a top-right layer switcher (matches the Industry map)
  const baseLayers = {
    "Street": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors", maxZoom: 19, noWrap: true,
    }),
    "Satellite": L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Tiles © Esri, Maxar, Earthstar Geographics", maxZoom: 19, noWrap: true },
    ),
    "Terrain": L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Tiles © Esri", maxZoom: 19, noWrap: true },
    ),
    "Light": L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png", {
      attribution: "© OSM · © CARTO", subdomains: "abcd", maxZoom: 19, noWrap: true,
    }),
    "Dark": L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", {
      attribution: "© OSM · © CARTO", subdomains: "abcd", maxZoom: 19, noWrap: true,
    }),
  };
  baseLayers.Satellite.addTo(mapInst);
  L.control.layers(baseLayers, null, { position: "topright", collapsed: true }).addTo(mapInst);
  addFullscreenControl(mapInst);

  const allLatLngs = [];

  try {
    const gjRes = await fetch(`assets/campus-boundaries/${MARKET.market_key}.geojson`, { cache: "no-cache" });
    if (gjRes.ok) {
      const gj = await gjRes.json();
      const layer = L.geoJSON(gj, {
        style: {
          color: "#d32f2f",
          weight: 2,
          opacity: 0.95,
          fillColor: "#d32f2f",
          fillOpacity: 0.18,
        },
        interactive: false,
      }).addTo(mapInst);
      const b = layer.getBounds();
      if (b.isValid()) {
        allLatLngs.push([b.getNorth(), b.getEast()]);
        allLatLngs.push([b.getSouth(), b.getWest()]);
      }
    }
  } catch { /* missing boundary file is fine */ }

  const POPUP_OPTS = { className: "market-popup-wrapper", maxWidth: 280, minWidth: 240, closeButton: true, autoPan: true };

  allCampuses.forEach((c) => {
    const isAnchor = c.university_name === MARKET.anchor_university;
    const marker = L.marker([c.campus_lat, c.campus_lng], {
      icon: campusMarkerIcon(isAnchor, MARKET.market_key, c.university_name),
      zIndexOffset: isAnchor ? 1000 : 500,
    }).addTo(mapInst);
    marker.bindPopup(`
      <div class="map-popup">
        <div class="map-popup-head">
          <div class="map-popup-eyebrow">${isAnchor ? "Anchor university" : "University"}</div>
          <div class="map-popup-title">${escapeHtml(c.university_name)}</div>
        </div>
        <div class="map-popup-body">
          <div class="map-popup-row">
            <span class="map-popup-row-label">IPEDS enrollment</span>
            <span class="map-popup-row-value">${fmtInt(c.total_enrollment)}<span class="map-popup-row-sub">${c.enrollment_year ? ` · ${c.enrollment_year}` : ""}</span></span>
          </div>
        </div>
      </div>
    `, POPUP_OPTS);
    allLatLngs.push([c.campus_lat, c.campus_lng]);
  });

  const phaseLabels = {
    "stable": "Stabilized",
    "lease up": "Lease-up",
    "under construction": "Under construction",
    "planned": "Planned",
  };

  propsWithCoords.forEach((p) => {
    const marker = L.marker([p.latitude, p.longitude], {
      icon: propMarkerIcon(p),
    }).addTo(mapInst);
    const phaseText = phaseLabels[p.phase] || (p.phase ? p.phase : "");
    const phaseSlug = (p.phase || "").replace(/\s+/g, "-").toLowerCase();
    marker.bindPopup(`
      <div class="map-popup">
        <div class="map-popup-head">
          <div class="map-popup-eyebrow-row">
            ${phaseText ? `<span class="map-popup-phase map-popup-phase-${phaseSlug}">${escapeHtml(phaseText)}</span>` : ""}
          </div>
          <div class="map-popup-title">${escapeHtml(p.property_name || "(unnamed)")}</div>
          ${p.street1 ? `<div class="map-popup-address">${escapeHtml(p.street1)}</div>` : ""}
        </div>
        <div class="map-popup-stats">
          <div class="map-popup-stat">
            <div class="map-popup-stat-label">Beds</div>
            <div class="map-popup-stat-value">${fmtInt(p.beds)}</div>
          </div>
          <div class="map-popup-stat">
            <div class="map-popup-stat-label">Built</div>
            <div class="map-popup-stat-value">${fmtYear(p.yearBuilt)}</div>
          </div>
          <div class="map-popup-stat">
            <div class="map-popup-stat-label">To campus</div>
            <div class="map-popup-stat-value">${fmtNum(p.milesToClosestCampus, 1)}<span class="map-popup-stat-unit">mi</span></div>
          </div>
          <div class="map-popup-stat">
            <div class="map-popup-stat-label">Avg rent</div>
            <div class="map-popup-stat-value">${fmtUsd(p.avg_rent)}</div>
          </div>
          <div class="map-popup-stat">
            <div class="map-popup-stat-label">Occupancy</div>
            <div class="map-popup-stat-value">${fmtPct(p.occupancy)}</div>
          </div>
          <div class="map-popup-stat">
            <div class="map-popup-stat-label">Pre-lease</div>
            <div class="map-popup-stat-value">${fmtPct(p.prelease)}</div>
          </div>
        </div>
        <a href="property.html?id=${p.property_key}" class="map-popup-link">
          View floor plans
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 5l7 7-7 7"/></svg>
        </a>
      </div>
    `, POPUP_OPTS);
    markerStore.set(p.property_key, marker);
    allLatLngs.push([p.latitude, p.longitude]);
  });

  if (allLatLngs.length > 1) {
    mapInst.fitBounds(allLatLngs, { padding: [40, 40], maxZoom: 14 });
  }
  return mapInst;
}

/* ----- Comp-set comparison charts ---------------------------- */
// Multi-year line charts: bed-weighted aggregate across selected comps per
// year vs the market history line. property_history is populated by
// load_property_history.py (pulls anchored annual snapshots from
// dbo.PlanReports). Updates whenever selection changes.

function weightedAvg(props, valueKey) {
  let num = 0, denom = 0;
  props.forEach((p) => {
    const v = p[valueKey];
    const w = p.beds;
    if (v == null || w == null) return;
    num += Number(v) * Number(w);
    denom += Number(w);
  });
  return denom > 0 ? num / denom : null;
}

// Bed-weighted aggregate of `valueKey` across a list of property_history
// rows. `rows` is an array of {property_key, year_, ...metrics, beds}.
function weightedAvgRows(rows, valueKey) {
  let num = 0, denom = 0;
  rows.forEach((r) => {
    const v = r[valueKey];
    const w = r.beds;
    if (v == null || w == null) return;
    num += Number(v) * Number(w);
    denom += Number(w);
  });
  return denom > 0 ? num / denom : null;
}

// For each year, bed-weighted aggregate across selected comps' property_history
// rows. Returns [{year, value}, ...].
function compYearlySeries(selectedKeys, valueKey) {
  const ph = DATA.tables.property_history || [];
  const filtered = ph.filter((r) => selectedKeys.has(r.property_key));
  const byYear = {};
  filtered.forEach((r) => {
    const y = Number(r.year_);
    (byYear[y] = byYear[y] || []).push(r);
  });
  return Object.keys(byYear)
    .map(Number)
    .sort((a, b) => a - b)
    .map((y) => ({ year: y, value: weightedAvgRows(byYear[y], valueKey) }));
}

// Market history series for the same metric (already aggregated per market
// in market_history). `marketKey` is MARKET.market_key. Field name differs
// per metric - pass the key in market_history.
function marketYearlySeries(marketKey, valueKey) {
  const mh = DATA.tables.market_history || [];
  return mh
    .filter((r) => r.market_key === marketKey && r[valueKey] != null)
    .map((r) => ({ year: Number(r.year_), value: Number(r[valueKey]) }))
    .sort((a, b) => a.year - b.year);
}

function renderCompCharts() {
  renderCompDetailTables();
  const selected = PROPERTIES.filter((p) => compSelection.has(p.property_key));
  const totalBeds = selected.reduce((s, p) => s + (p.beds || 0), 0);
  const selectedKeys = new Set(selected.map((p) => p.property_key));
  const summary = document.getElementById("comp-perf-summary");
  if (summary) {
    summary.textContent = selected.length === 0
      ? "No comps selected. Tick a checkbox above to populate the charts."
      : `${selected.length} comp${selected.length === 1 ? "" : "s"} selected · `
        + `${totalBeds.toLocaleString()} beds (bed-weighted aggregate · 2020–latest snapshot)`;
  }

  const mkKey = MARKET.market_key;
  const fmtUsdInt = (v) => "$" + Math.round(v).toLocaleString();
  const fmtUsdCents = (v) => "$" + v.toFixed(2);
  const fmtPctVal = (v) => (v * 100).toFixed(1) + "%";

  drawCompLine("comp-perf-rent",
    compYearlySeries(selectedKeys, "avg_rent_per_bed"),
    marketYearlySeries(mkKey, "avg_rent_per_bed"),
    { yFmt: fmtUsdInt });
  drawCompLine("comp-perf-rent-sf",
    compYearlySeries(selectedKeys, "avg_rent_per_sf"),
    marketYearlySeries(mkKey, "avg_rent_per_sf"),
    { yFmt: fmtUsdCents });
  drawCompLine("comp-perf-occupancy",
    compYearlySeries(selectedKeys, "occupancy"),
    marketYearlySeries(mkKey, "occupancy"),
    { yFmt: fmtPctVal, isPct: true });
  drawCompLine("comp-perf-prelease",
    compYearlySeries(selectedKeys, "prelease"),
    marketYearlySeries(mkKey, "prelease"),
    { yFmt: fmtPctVal, isPct: true });

  renderUnitMix();

  // Comp Map Generator (comp-map.js) tracks the same selection.
  if (window.CompMap) window.CompMap.refresh();
}

/* ----- Unit & Bed Mix (Comps tab) ---------------------------- */
// Stacked bar of the selected comps by bedroom type - one stack segment per
// property - plus a market summary table (count + % of each type) and a
// per-property matrix. Toggles between authoritative bed counts and derived
// unit counts. Data: tables.unit_mix (built by load_unit_mix.py).

const UNIT_MIX_TYPES = ["Studio", "1BR", "2BR", "3BR", "4BR", "5BR", "6BR+"];

// Per-property segment palette: brand tones first, then a distinct spread so
// stacks stay readable past ~6 comps. Pipeline phases get a lighter wash.
const UNIT_MIX_PALETTE = [
  "#16352e", "#a95818", "#4f7a6f", "#c7973f", "#6d5b8e",
  "#3d8aa6", "#8c6d46", "#9c4a3c", "#5a8c4a", "#b0894d",
  "#42606d", "#7a4f63",
];

// Fixed colour per bedroom type for the per-building pie (slices = types).
const UNIT_TYPE_COLORS = {
  "Studio": "#6d5b8e",
  "1BR": "#3d8aa6",
  "2BR": "#4f7a6f",
  "3BR": "#c7973f",
  "4BR": "#a95818",
  "5BR": "#16352e",
  "6BR+": "#9c4a3c",
};

function unitMixByProperty() {
  // property_key → unit_mix row, scoped to this market.
  const rows = (DATA.tables.unit_mix || []).filter(
    (r) => r.market_key === MARKET.market_key
  );
  return new Map(rows.map((r) => [r.property_key, r]));
}

function renderUnitMix() {
  const canvas = document.getElementById("unitmix-chart");
  if (!canvas || typeof Chart === "undefined") return;

  const metric = unitMixMetric;              // "beds" | "units"
  const field = metric === "beds" ? "beds_by_type" : "units_by_type";
  const noun = metric === "beds" ? "beds" : "units";
  const mixByProp = unitMixByProperty();

  // Selected comps that actually have floor-plan mix data, biggest first.
  const selected = PROPERTIES
    .filter((p) => compSelection.has(p.property_key) && mixByProp.has(p.property_key))
    .map((p) => ({ prop: p, mix: mixByProp.get(p.property_key) }))
    .sort((a, b) => (b.mix.total_beds || 0) - (a.mix.total_beds || 0));

  // Only show bedroom types present across the selection.
  const typesPresent = UNIT_MIX_TYPES.filter((t) =>
    selected.some(({ mix }) => (mix[field] || {})[t])
  );

  const summaryEl = document.getElementById("unitmix-summary");
  if (summaryEl) {
    const withMix = selected.length;
    const totalSel = PROPERTIES.filter((p) => compSelection.has(p.property_key)).length;
    const noData = totalSel - withMix;
    summaryEl.textContent = withMix === 0
      ? "No selected comps have floor-plan data. Tick comps above to populate this section."
      : `Inventory by bedroom type across ${withMix} comp${withMix === 1 ? "" : "s"}, `
        + `stacked by property${noData > 0 ? ` (${noData} selected comp${noData === 1 ? "" : "s"} lack floor-plan data)` : ""}.`;
  }

  // Sync titles + toggle button state to the active metric.
  const metricLabel = metric === "beds" ? "Beds" : "Units";
  const sumTitle = document.getElementById("unitmix-summary-title");
  const matTitle = document.getElementById("unitmix-matrix-title");
  if (sumTitle) sumTitle.textContent = `Market Summary - ${metricLabel} by Type`;
  if (matTitle) matTitle.textContent = `By Property - ${metricLabel} by Type`;
  document.querySelectorAll(".unitmix-toggle-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mix === metric)
  );

  // ---- Stacked bar: x = bedroom type, one dataset per property ----------
  const datasets = selected.map(({ prop, mix }, i) => {
    const color = UNIT_MIX_PALETTE[i % UNIT_MIX_PALETTE.length];
    const isPipeline = !["stable", "lease up"].includes(prop.phase);
    return {
      label: prop.property_name + (isPipeline ? ` (${prop.phase})` : ""),
      data: typesPresent.map((t) => (mix[field] || {})[t] || 0),
      backgroundColor: isPipeline ? color + "b3" : color,  // pipeline = lighter
      borderColor: "#fff",
      borderWidth: 1,
      borderRadius: 1,
    };
  });

  // Stack totals, drawn above each bar.
  const stackTotals = typesPresent.map((t, ti) =>
    datasets.reduce((s, ds) => s + (ds.data[ti] || 0), 0)
  );

  const totalsPlugin = {
    id: "unitMixTotals",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(chart.data.datasets.length - 1);
      if (!meta || !meta.data) return;
      ctx.save();
      ctx.fillStyle = "#16352e";
      ctx.font = "700 13px Pragmatica, sans-serif";
      ctx.textAlign = "center";
      meta.data.forEach((bar, i) => {
        const total = stackTotals[i];
        if (!total) return;
        ctx.fillText(fmtInt(total), bar.x, bar.y - 6);
      });
      ctx.restore();
    },
  };

  if (unitMixChart) unitMixChart.destroy();
  unitMixChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels: typesPresent, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 22 } },
      plugins: {
        legend: {
          position: "bottom",
          labels: { font: { size: 11, family: "Pragmatica, sans-serif" }, color: "#2b2825",
                    boxWidth: 12, boxHeight: 12, padding: 10 },
        },
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}: ${fmtInt(c.parsed.y)} ${noun}`,
          },
        },
        // Per-segment values are noise; only the stack total (drawn by
        // unitMixTotals) sits above each bar. Hover for the per-comp number.
        datalabels: { display: false },
      },
      scales: {
        x: { stacked: true, grid: { display: false, drawBorder: false },
             border: { display: false },
             ticks: { font: { size: 13, weight: 600, family: "Pragmatica, sans-serif" }, color: "#2b2825" } },
        y: { stacked: true, beginAtZero: true,
             title: { display: true, text: metric === "beds" ? "Bed Count" : "Unit Count",
                      font: { size: 11, family: "Pragmatica, sans-serif" }, color: "#5a544f" },
             grid: { color: "#f5efde", drawTicks: false }, border: { display: false },
             ticks: { color: "#5a544f", font: { size: 11 } } },
      },
    },
    plugins: [totalsPlugin],
  });

  renderUnitMixTables(selected, typesPresent, field, noun);
  renderUnitSizeChart(selected);
  populateUnitMixBuildingPicker(selected);
  renderUnitMixPie(selected, field, noun);
  populateUnitMixParityPicker(selected);
  renderUnitMixParityPie(selected);
}

/* Average unit size (sf) by exact unit type (#BR / #BA), as a single
   units-weighted average across the selected comps. For each unit type the
   mean is sum(avg_sf * units) / sum(units) over the comps that report it, so
   bigger comps pull the average proportionally. A 4x4 is a distinct bar from
   a 4x2. Independent of the By Bed/By Unit toggle. Data: each comp's
   size_by_unit (built in load_unit_mix.py), carrying avg_sf + units +
   beds/baths/cat per unit type. */
function renderUnitSizeChart(selected) {
  const figure = document.getElementById("unitmix-size-figure");
  const canvas = document.getElementById("unitmix-size-chart");
  if (!figure || !canvas || typeof Chart === "undefined") return;

  // Accumulate units-weighted size per exact unit type (keyed by label).
  const agg = {};  // label -> { sf, units, beds, baths, cat }
  selected.forEach(({ mix }) => {
    (mix.size_by_unit || []).forEach((e) => {
      if (!e.avg_sf || !e.units) return;
      const a = agg[e.label] || (agg[e.label] = {
        sf: 0, units: 0, beds: e.beds, baths: e.baths, cat: e.cat,
      });
      a.sf += e.avg_sf * e.units;
      a.units += e.units;
    });
  });

  // Ordered small-to-large by beds then baths.
  const cats = Object.keys(agg)
    .map((label) => ({ label, ...agg[label] }))
    .filter((a) => a.units > 0)
    .sort((x, y) => (x.beds - y.beds) || ((x.baths ?? -1) - (y.baths ?? -1)))
    .map((a) => ({
      label: a.label,
      color: UNIT_TYPE_COLORS[a.cat] || "#837c75",
      value: Math.round(a.sf / a.units),
      units: a.units,
    }));

  if (unitMixSizeChart) { unitMixSizeChart.destroy(); unitMixSizeChart = null; }
  if (cats.length === 0) {
    figure.style.display = "none";
    return;
  }
  figure.style.display = "";

  const values = cats.map((c) => c.value);
  const totalsPlugin = {
    id: "unitSizeTotals",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data) return;
      ctx.save();
      ctx.fillStyle = "#16352e";
      ctx.font = "700 13px Pragmatica, sans-serif";
      ctx.textAlign = "center";
      meta.data.forEach((bar, i) => {
        if (!values[i]) return;
        ctx.fillText(`${fmtInt(values[i])} SF`, bar.x, bar.y - 6);
      });
      ctx.restore();
    },
  };

  unitMixSizeChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: cats.map((c) => c.label),
      datasets: [{
        label: "Avg SF",
        data: values,
        backgroundColor: cats.map((c) => c.color),
        borderColor: "#fff",
        borderWidth: 1,
        borderRadius: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 22 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `${fmtInt(c.parsed.y)} sf avg`,
            afterLabel: (c) => `${fmtInt(cats[c.dataIndex].units)} units across comps`,
          },
        },
        datalabels: { display: false },
      },
      scales: {
        x: { grid: { display: false, drawBorder: false }, border: { display: false },
             ticks: { font: { size: 12, weight: 600, family: "Pragmatica, sans-serif" }, color: "#2b2825",
                      maxRotation: 30, minRotation: 0 } },
        y: { beginAtZero: true,
             title: { display: true, text: "Square Feet",
                      font: { size: 11, family: "Pragmatica, sans-serif" }, color: "#5a544f" },
             grid: { color: "#f5efde", drawTicks: false }, border: { display: false },
             ticks: { color: "#5a544f", font: { size: 11 } } },
      },
    },
    plugins: [totalsPlugin],
  });
}

// Parity slice colours: full = everest (good), none = birch (shared baths).
const PARITY_COLORS = { full: "#16352e", partial: "#a95818" };

/* Bed/bath parity pie: share of beds (or units, per the By Bed/By Unit
   toggle) where every bedroom has its own bath. Filterable by bedroom type. */
function populateUnitMixParityPicker(selected) {
  const sel = document.getElementById("unitmix-parity-type");
  if (!sel) return;
  // Bedroom types that appear in the parity data across the selection.
  const present = UNIT_MIX_TYPES.filter((t) =>
    selected.some(({ mix }) => (mix.parity_by_type || {})[t]));
  if (unitMixParityType !== "all" && !present.includes(unitMixParityType)) {
    unitMixParityType = "all";
  }
  const opts = [`<option value="all">All bedroom types</option>`].concat(
    present.map((t) => `<option value="${t}">${t}</option>`));
  sel.innerHTML = opts.join("");
  sel.value = unitMixParityType;
}

function renderUnitMixParityPie(selected) {
  const canvas = document.getElementById("unitmix-parity-pie");
  if (!canvas || typeof Chart === "undefined") return;
  const titleEl = document.getElementById("unitmix-parity-title");

  const useBeds = unitMixMetric === "beds";
  const fullKey = useBeds ? "beds_full" : "units_full";
  const partialKey = useBeds ? "beds_partial" : "units_partial";
  const noun = useBeds ? "beds" : "units";
  const metricLabel = useBeds ? "Beds" : "Units";

  let full = 0, partial = 0;
  selected.forEach(({ mix }) => {
    const pbt = mix.parity_by_type || {};
    const types = unitMixParityType === "all" ? Object.keys(pbt) : [unitMixParityType];
    types.forEach((t) => {
      if (!pbt[t]) return;
      full += pbt[t][fullKey] || 0;
      partial += pbt[t][partialKey] || 0;
    });
  });
  const total = full + partial;

  const scope = unitMixParityType === "all" ? "" : ` - ${unitMixParityType}`;
  if (titleEl) titleEl.textContent = `Bed / Bath Parity${scope} (${metricLabel})`;

  if (unitMixParityChart) unitMixParityChart.destroy();
  if (!total) {
    unitMixParityChart = null;
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  unitMixParityChart = new Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: {
      labels: ["Full parity", "No parity"],
      datasets: [{
        data: [full, partial],
        backgroundColor: [PARITY_COLORS.full, PARITY_COLORS.partial],
        borderColor: "#fff",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "52%",
      layout: { padding: 6 },
      plugins: {
        legend: {
          position: "right",
          labels: { font: { size: 11, family: "Pragmatica, sans-serif" }, color: "#2b2825",
                    boxWidth: 12, boxHeight: 12, padding: 9 },
        },
        tooltip: {
          callbacks: {
            label: (c) => `${c.label}: ${fmtInt(c.parsed)} ${noun} (${(c.parsed / total * 100).toFixed(1)}%)`,
          },
        },
        datalabels: {
          color: "#fff",
          font: { weight: 700, size: 12, family: "Pragmatica, sans-serif" },
          textAlign: "center",
          formatter: (v) => {
            const pct = v / total * 100;
            if (pct < 6) return "";
            return `${pct.toFixed(0)}%`;
          },
        },
      },
    },
  });
}

/* Per-building unit-type pie. Slices are bedroom types for one building (or
   the aggregate of all selected comps), coloured by type, labelled with %. */
function populateUnitMixBuildingPicker(selected) {
  const sel = document.getElementById("unitmix-pie-building");
  if (!sel) return;
  const validKeys = new Set(selected.map(({ prop }) => prop.property_key));
  // Reset the choice if the previously-picked building left the selection.
  if (unitMixPieBuilding !== "all" && !validKeys.has(unitMixPieBuilding)) {
    unitMixPieBuilding = selected.length ? selected[0].prop.property_key : "all";
  }
  if (unitMixPieBuilding === null) {
    unitMixPieBuilding = selected.length ? selected[0].prop.property_key : "all";
  }
  const opts = [`<option value="all">All selected comps</option>`].concat(
    selected.map(({ prop }) =>
      `<option value="${prop.property_key}">${prop.property_name}</option>`)
  );
  sel.innerHTML = opts.join("");
  sel.value = String(unitMixPieBuilding);
}

/* Nested unit-mix doughnut config. Inner ring = bedroom type; outer ring =
   each type split into en-suite (solid) vs shared-bath (lighter shade). Both
   rings derive from parity_by_type so they reconcile exactly. perType is
   { type: {full, partial} } in the active metric. Returns a Chart.js config,
   or null when there is nothing to draw. Shared by market + property pies. */
function buildNestedMixConfig(perType, noun) {
  const types = UNIT_MIX_TYPES.filter((t) => perType[t] && (perType[t].full + perType[t].partial) > 0);
  const total = types.reduce((s, t) => s + perType[t].full + perType[t].partial, 0);
  if (!total) return null;

  const innerData = types.map((t) => perType[t].full + perType[t].partial);
  const innerColors = types.map((t) => UNIT_TYPE_COLORS[t] || "#837c75");

  const outerData = [], outerColors = [], outerMeta = [];
  types.forEach((t) => {
    const base = UNIT_TYPE_COLORS[t] || "#837c75";
    outerData.push(perType[t].full);    outerColors.push(base);          outerMeta.push({ type: t, kind: "en-suite", val: perType[t].full });
    outerData.push(perType[t].partial); outerColors.push(base + "80");   outerMeta.push({ type: t, kind: "shared bath", val: perType[t].partial });
  });

  return {
    type: "doughnut",
    data: {
      labels: types,
      datasets: [
        { data: innerData, backgroundColor: innerColors, borderColor: "#fff", borderWidth: 2,
          datalabels: {
            color: "#fff", textAlign: "center",
            font: { weight: 700, size: 11, family: "Pragmatica, sans-serif" },
            formatter: (v, ctx) => (v / total * 100) < 7 ? "" : types[ctx.dataIndex],
          } },
        { data: outerData, backgroundColor: outerColors, borderColor: "#fff", borderWidth: 2,
          datalabels: {
            color: "#2b2825", textAlign: "center",
            font: { weight: 700, size: 10, family: "Pragmatica, sans-serif" },
            // Quantify only the shared-bath segments that are big enough to read.
            formatter: (v, ctx) => {
              const m = outerMeta[ctx.dataIndex];
              if (m.kind !== "shared bath") return "";
              const pct = v / total * 100;
              return pct < 5 ? "" : `${pct.toFixed(0)}%`;
            },
          } },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "40%",
      layout: { padding: 6 },
      plugins: {
        legend: {
          position: "right",
          onClick: () => {},   // toggling is meaningless across two rings
          labels: { font: { size: 11, family: "Pragmatica, sans-serif" }, color: "#2b2825",
                    boxWidth: 12, boxHeight: 12, padding: 9 },
        },
        tooltip: {
          callbacks: {
            label: (c) => {
              if (c.datasetIndex === 0) {
                return `${types[c.dataIndex]}: ${fmtInt(c.parsed)} ${noun} (${(c.parsed / total * 100).toFixed(1)}%)`;
              }
              const m = outerMeta[c.dataIndex];
              return `${m.type} ${m.kind}: ${fmtInt(m.val)} ${noun}`;
            },
          },
        },
      },
    },
  };
}

function renderUnitMixPie(selected, field, noun) {
  const canvas = document.getElementById("unitmix-pie");
  if (!canvas || typeof Chart === "undefined") return;
  const titleEl = document.getElementById("unitmix-pie-title");

  const useBeds = noun === "beds";
  const fullKey = useBeds ? "beds_full" : "units_full";
  const partKey = useBeds ? "beds_partial" : "units_partial";

  // Aggregate parity-by-type across the scope: one building or all comps.
  let buildingName = "Comp Set";
  const perType = {};
  const addPbt = (pbt) => {
    UNIT_MIX_TYPES.forEach((t) => {
      const e = pbt[t]; if (!e) return;
      const slot = perType[t] || (perType[t] = { full: 0, partial: 0 });
      slot.full += e[fullKey] || 0;
      slot.partial += e[partKey] || 0;
    });
  };
  if (unitMixPieBuilding === "all") {
    selected.forEach(({ mix }) => addPbt(mix.parity_by_type || {}));
  } else {
    const hit = selected.find(({ prop }) => prop.property_key === unitMixPieBuilding);
    if (hit) { addPbt(hit.mix.parity_by_type || {}); buildingName = hit.prop.property_name; }
  }

  if (titleEl) titleEl.textContent = `${buildingName} (${useBeds ? "Beds" : "Units"})`;

  if (unitMixPieChart) { unitMixPieChart.destroy(); unitMixPieChart = null; }
  const config = buildNestedMixConfig(perType, noun);
  if (!config) {
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  unitMixPieChart = new Chart(canvas.getContext("2d"), config);
}

function renderUnitMixTables(selected, typesPresent, field, noun) {
  // ---- Market summary: bedroom type × [count, % of total] --------------
  const totals = {};
  typesPresent.forEach((t) => {
    totals[t] = selected.reduce((s, { mix }) => s + ((mix[field] || {})[t] || 0), 0);
  });
  const grand = Object.values(totals).reduce((s, v) => s + v, 0);
  const pct = (v) => (grand ? (v / grand * 100).toFixed(1) + "%" : "-");

  const nounLabel = noun === "beds" ? "Beds" : "Units";
  const summaryTable = document.getElementById("unitmix-summary-table");
  if (summaryTable) {
    if (grand === 0) {
      summaryTable.innerHTML = `<tbody><tr><td>No data for the current selection.</td></tr></tbody>`;
    } else {
      const head = `<thead><tr><th class="property-cell">Type</th><th>${nounLabel}</th><th>% of total</th></tr></thead>`;
      const body = typesPresent.map((t) =>
        `<tr><td class="property-cell">${t}</td><td>${fmtInt(totals[t])}</td><td>${pct(totals[t])}</td></tr>`
      ).join("");
      const foot = `<tfoot><tr><td class="property-cell">Total</td><td>${fmtInt(grand)}</td><td>100.0%</td></tr></tfoot>`;
      summaryTable.innerHTML = head + `<tbody>${body}</tbody>` + foot;
    }
  }

  // ---- Per-property matrix: property × bedroom type (+ total) ----------
  const matrix = document.getElementById("unitmix-matrix-table");
  if (matrix) {
    if (selected.length === 0) {
      matrix.innerHTML = `<tbody><tr><td>No data for the current selection.</td></tr></tbody>`;
    } else {
      const head = `<thead><tr><th class="property-cell">Property</th>${typesPresent.map((t) => `<th>${t}</th>`).join("")}<th>Total</th></tr></thead>`;
      const rows = selected.map(({ prop, mix }) => {
        const cells = typesPresent.map((t) => {
          const v = (mix[field] || {})[t] || 0;
          return `<td>${v ? fmtInt(v) : "-"}</td>`;
        }).join("");
        const rowTotal = typesPresent.reduce((s, t) => s + ((mix[field] || {})[t] || 0), 0);
        return `<tr><td class="property-cell">${prop.property_name}</td>${cells}<td>${fmtInt(rowTotal)}</td></tr>`;
      }).join("");
      const foot = `<tfoot><tr><td class="property-cell">Total</td>${typesPresent.map((t) => `<td>${fmtInt(totals[t])}</td>`).join("")}<td>${fmtInt(grand)}</td></tr></tfoot>`;
      matrix.innerHTML = head + `<tbody>${rows}</tbody>` + foot;
    }
  }
}

function bindUnitMixToggle() {
  document.querySelectorAll(".unitmix-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.mix;
      if (next === unitMixMetric) return;
      unitMixMetric = next;
      renderUnitMix();
    });
  });

  // Building picker for the pie: re-render just the pie on change. The
  // <select> element persists across renders (only its options are rebuilt),
  // so this listener stays attached.
  const sel = document.getElementById("unitmix-pie-building");
  if (sel) {
    sel.addEventListener("change", () => {
      unitMixPieBuilding = sel.value === "all" ? "all" : Number(sel.value);
      renderUnitMix();
    });
  }

  // Bedroom-type filter for the bed/bath parity pie.
  const parSel = document.getElementById("unitmix-parity-type");
  if (parSel) {
    parSel.addEventListener("change", () => {
      unitMixParityType = parSel.value;
      renderUnitMix();
    });
  }
}

const COMP_LINE_COLOR_COMP   = "#a95818";   // rust - comp aggregate
const COMP_LINE_COLOR_MARKET = "#16352e";   // everest - market

function drawCompLine(canvasId, compSeries, marketSeries, { yFmt, isPct = false } = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === "undefined") return;
  if (compCharts[canvasId]) compCharts[canvasId].destroy();

  // Union of years across both series so the x-axis is consistent.
  const yearSet = new Set();
  compSeries.forEach((d) => yearSet.add(d.year));
  marketSeries.forEach((d) => yearSet.add(d.year));
  const years = [...yearSet].sort((a, b) => a - b);
  const compByYear = Object.fromEntries(compSeries.map((d) => [d.year, d.value]));
  const marketByYear = Object.fromEntries(marketSeries.map((d) => [d.year, d.value]));

  const compData = years.map((y) => compByYear[y] ?? null);
  const marketData = years.map((y) => marketByYear[y] ?? null);

  compCharts[canvasId] = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels: years,
      datasets: [
        {
          label: "Comps",
          data: compData,
          borderColor: COMP_LINE_COLOR_COMP,
          backgroundColor: COMP_LINE_COLOR_COMP,
          borderWidth: 2.5,
          pointRadius: 3,
          pointHoverRadius: 5,
          tension: 0.25,
          spanGaps: true,
        },
        {
          label: "Market",
          data: marketData,
          borderColor: COMP_LINE_COLOR_MARKET,
          backgroundColor: COMP_LINE_COLOR_MARKET,
          borderWidth: 2,
          borderDash: [5, 4],
          pointRadius: 2.5,
          pointHoverRadius: 5,
          tension: 0.25,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: { font: { size: 11 }, boxWidth: 18, padding: 10, usePointStyle: true },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y == null ? "-" : yFmt(ctx.parsed.y)}`,
          },
        },
        datalabels: { display: false },
      },
      scales: {
        x: {
          ticks: { color: "#5a544f", font: { size: 11 } },
          grid: { display: false },
        },
        y: {
          beginAtZero: false,
          ...(isPct ? { max: 1 } : {}),
          ticks: {
            color: "#5a544f",
            callback: (v) => yFmt(v),
            font: { size: 11 },
          },
          grid: { color: "rgba(0,0,0,0.05)" },
        },
      },
      interaction: { mode: "index", intersect: false },
    },
  });
}

/* ----- Enrollment History (Market tab) ----------------------- */
// Three multi-year line charts (FTE / Freshman / Total) for the
// anchor university, plus YoY / 2-Yr / 3-Yr growth tiles above each
// chart - Excel-style summary. Sourced from `enrollment_history`,
// pulled by load_enrollment_history.py.

let enrCharts = {};

function renderEnrollment() {
  // Find the anchor university's IPEDS id via campus_locations.
  const anchorCampus = (CAMPUSES || []).find(
    (c) => c.university_name === MARKET.anchor_university,
  ) || CAMPUSES[0];
  const ipeds = anchorCampus?.ipeds_id;
  const sub = document.getElementById("enr-section-sub");
  if (sub) {
    sub.textContent = anchorCampus
      ? `${anchorCampus.university_name} - Full-time, Freshman, and Total enrollment year-over-year. (Applications source not yet wired.)`
      : "Anchor university not found in campus_locations.";
  }

  const series = ((DATA.tables.enrollment_history) || [])
    .filter((r) => r.ipeds_id === ipeds)
    .filter((r) => r.year_ != null)
    .sort((a, b) => Number(a.year_) - Number(b.year_));

  drawEnrollmentChart({
    canvasId: "enr-chart-fte",
    statsId: "enr-stats-fte",
    subId: "enr-fte-sub",
    series,
    valueKey: "full_time_enrollment",
    color: "#a95818",  // rust
    label: "FTE",
  });
  drawEnrollmentChart({
    canvasId: "enr-chart-freshman",
    statsId: "enr-stats-freshman",
    subId: "enr-freshman-sub",
    series,
    valueKey: "freshman_enrollment",
    color: "#16352e",  // everest
    label: "Freshman",
  });
  drawEnrollmentChart({
    canvasId: "enr-chart-total",
    statsId: "enr-stats-total",
    subId: "enr-total-sub",
    series,
    valueKey: "total_enrollment",
    color: "#2b2825",  // slate
    label: "Total",
  });
}

function _enrGrowth(curr, prev) {
  if (curr == null || prev == null || prev === 0) return null;
  return (curr - prev) / prev;
}
function _enrFmtPct(v) {
  if (v == null) return "-";
  return (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
}

function drawEnrollmentChart({ canvasId, statsId, subId, series, valueKey, color, label }) {
  const canvas = document.getElementById(canvasId);
  const statsEl = document.getElementById(statsId);
  const subEl = document.getElementById(subId);
  if (!canvas || typeof Chart === "undefined") return;

  // Keep only rows with the metric populated. Limit to last 8 years so the
  // x-axis stays legible.
  const data = series
    .filter((r) => r[valueKey] != null && r[valueKey] > 0)
    .slice(-8);

  if (data.length === 0) {
    if (statsEl) statsEl.innerHTML = `<div class="enr-empty">No ${label.toLowerCase()} history for this university.</div>`;
    if (subEl) subEl.textContent = "";
    if (enrCharts[canvasId]) { enrCharts[canvasId].destroy(); enrCharts[canvasId] = null; }
    return;
  }

  const years = data.map((r) => Number(r.year_));
  const values = data.map((r) => Number(r[valueKey]));
  const latest = values[values.length - 1];
  const yoy   = values.length >= 2 ? _enrGrowth(latest, values[values.length - 2]) : null;
  const twoYr = values.length >= 3 ? _enrGrowth(latest, values[values.length - 3]) : null;
  const threeYr = values.length >= 4 ? _enrGrowth(latest, values[values.length - 4]) : null;

  if (subEl) {
    subEl.textContent = `Latest: ${latest.toLocaleString()} · ${years[years.length - 1]}`;
  }

  if (statsEl) {
    statsEl.innerHTML = `
      <div class="enr-stat">
        <span class="enr-stat-label">YoY Growth</span>
        <span class="enr-stat-value ${yoy != null && yoy >= 0 ? "growth-up" : yoy != null ? "growth-down" : ""}">${_enrFmtPct(yoy)}</span>
      </div>
      <div class="enr-stat">
        <span class="enr-stat-label">2-Yr Growth</span>
        <span class="enr-stat-value ${twoYr != null && twoYr >= 0 ? "growth-up" : twoYr != null ? "growth-down" : ""}">${_enrFmtPct(twoYr)}</span>
      </div>
      <div class="enr-stat">
        <span class="enr-stat-label">3-Yr Growth</span>
        <span class="enr-stat-value ${threeYr != null && threeYr >= 0 ? "growth-up" : threeYr != null ? "growth-down" : ""}">${_enrFmtPct(threeYr)}</span>
      </div>`;
  }

  if (enrCharts[canvasId]) enrCharts[canvasId].destroy();
  enrCharts[canvasId] = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels: years,
      datasets: [{
        data: values,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2.5,
        pointRadius: 4,
        pointHoverRadius: 6,
        tension: 0.2,
        fill: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 22, right: 12, left: 4, bottom: 4 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${label}: ${Number(ctx.parsed.y).toLocaleString()}`,
          },
        },
        datalabels: {
          align: "top",
          anchor: "end",
          offset: 4,
          color: "#2b2825",
          font: { family: "Mencken Std, Georgia, serif", weight: 700, size: 11 },
          formatter: (v) => v == null ? "" : Number(v).toLocaleString(),
          clip: false,
        },
      },
      scales: {
        x: {
          ticks: { color: "#5a544f", font: { size: 11 } },
          grid: { display: false },
        },
        y: {
          beginAtZero: false,
          ticks: {
            color: "#5a544f",
            font: { size: 11 },
            callback: (v) => Number(v).toLocaleString(),
          },
          grid: { color: "rgba(0,0,0,0.05)" },
        },
      },
    },
    plugins: window.ChartDataLabels ? [window.ChartDataLabels] : [],
  });
}

/* ----- Comp-set per-year detail tables ----------------------- */
// Four Excel-style tables driven by property_history, scoped to the
// selected comps: Rates, Rent Growth (YoY), Pre-lease, Occupancy. Footer
// rows show bed-weighted aggregates plus YoY/2-Yr/3-Yr growth.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function renderCompDetailTables() {
  // Rows ordered by year built, newest first - matches the comp-set
  // properties table's default sort.
  const selected = PROPERTIES
    .filter((p) => compSelection.has(p.property_key))
    .sort((a, b) => (b.yearBuilt ?? -Infinity) - (a.yearBuilt ?? -Infinity));
  const selectedKeys = new Set(selected.map((p) => p.property_key));
  const propsByKey = new Map(selected.map((p) => [p.property_key, p]));

  const ph = (DATA.tables.property_history || []).filter((r) => selectedKeys.has(r.property_key));

  // Years across the comp pool, sorted ascending. Limit to the most recent
  // 5 to keep tables readable; users can pull the SQL refresh for the rest.
  const yearSet = new Set(ph.map((r) => Number(r.year_)));
  const years = [...yearSet].sort((a, b) => a - b).slice(-5);

  // Anchor month - pull from any property_history row to label the
  // prelease / occupancy tables ("Pre-lease (May)"). Falls back to ''.
  let anchorMonth = "";
  if (ph.length > 0) {
    const iso = ph[0].data_as_of;
    if (typeof iso === "string" && iso.length >= 7) {
      const m = Number(iso.slice(5, 7));
      if (m >= 1 && m <= 12) anchorMonth = MONTH_NAMES[m - 1];
    }
  }
  // Replace only the text node - chart-download.js appends a CSV download
  // button into these title bands, and textContent would wipe it.
  const setTitleText = (el, text) => {
    if (!el) return;
    if (el.firstChild && el.firstChild.nodeType === Node.TEXT_NODE) {
      el.firstChild.nodeValue = text;
    } else {
      el.insertBefore(document.createTextNode(text), el.firstChild);
    }
  };
  setTitleText(document.getElementById("comp-table-prelease-title"),
    anchorMonth ? `Pre-lease (${anchorMonth})` : "Pre-lease");
  setTitleText(document.getElementById("comp-table-occupancy-title"),
    anchorMonth ? `Occupancy (${anchorMonth})` : "Occupancy");

  if (selected.length === 0) {
    ["comp-table-rates", "comp-table-rent-growth", "comp-table-prelease", "comp-table-occupancy"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<thead><tr><th>-</th></tr></thead><tbody><tr><td class="empty-state">No comps selected.</td></tr></tbody>`;
    });
    return;
  }

  // Build {property_key: {year: row}} lookup for quick access.
  const lookup = {};
  ph.forEach((r) => {
    const k = r.property_key;
    const y = Number(r.year_);
    (lookup[k] = lookup[k] || {})[y] = r;
  });

  // ---- Rates table -----------------------------------------
  renderRatesTable("comp-table-rates", selected, propsByKey, lookup, years);

  // ---- Rent Growth table -----------------------------------
  renderRentGrowthTable("comp-table-rent-growth", selected, propsByKey, lookup, years);

  // ---- Prelease & Occupancy tables -------------------------
  renderPctTable("comp-table-prelease", selected, propsByKey, lookup, years, "prelease");
  renderPctTable("comp-table-occupancy", selected, propsByKey, lookup, years, "occupancy");
}

function _bedWeighted(rows, field) {
  let num = 0, den = 0;
  rows.forEach((r) => {
    const v = r && r[field];
    const w = r && r.beds;
    if (v == null || w == null) return;
    num += Number(v) * Number(w);
    den += Number(w);
  });
  return den > 0 ? num / den : null;
}

function _growth(curr, prev) {
  if (curr == null || prev == null || prev === 0) return null;
  return (curr - prev) / prev;
}

function _fmtUsd(v) {
  return v == null ? "" : "$" + Math.round(v).toLocaleString();
}
function _fmtPct1(v) {
  return v == null ? "" : (v * 100).toFixed(1) + "%";
}
function _fmtPct0(v) {
  return v == null ? "" : Math.round(v * 100) + "%";
}
function _signedPct1(v) {
  if (v == null) return "";
  return (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
}

function _growthClass(v) {
  if (v == null) return "";
  return v >= 0 ? "growth-up" : "growth-down";
}

// Shared property-attribute columns (Built / Mi to Campus / Beds) shown on
// every comp detail table, between the property name and the year columns.
const COMP_META_HEAD = `<th class="num">Built</th><th class="num">Mi to Campus</th><th class="num">Beds</th>`;
const COMP_META_COLS = 3;

function compMetaCells(p) {
  return `<td class="num">${fmtYear(p.yearBuilt)}</td>`
       + `<td class="num">${fmtNum(p.milesToClosestCampus, 1)}</td>`
       + `<td class="num">${fmtInt(p.beds)}</td>`;
}

function renderRatesTable(id, selected, propsByKey, lookup, years) {
  const table = document.getElementById(id);
  if (!table) return;
  const head = `
    <thead>
      <tr>
        <th class="property-cell">Property</th>
        ${COMP_META_HEAD}
        ${years.map((y) => `<th class="num">${y}</th>`).join("")}
      </tr>
    </thead>`;
  const bodyRows = selected.map((p) => {
    return `<tr>
      <td class="property-cell">${escapeHtml(p.property_name || "(unnamed)")}</td>
      ${compMetaCells(p)}
      ${years.map((y) => {
        const r = lookup[p.property_key]?.[y];
        return `<td class="num">${_fmtUsd(r?.avg_rent_per_bed)}</td>`;
      }).join("")}
    </tr>`;
  }).join("");

  // Footer: bed-weighted Avg Rent + growth rows
  const avgByYear = {};
  years.forEach((y) => {
    const rows = selected.map((p) => lookup[p.property_key]?.[y]).filter(Boolean);
    avgByYear[y] = _bedWeighted(rows, "avg_rent_per_bed");
  });
  const yoyRow = years.map((y, i) => {
    if (i === 0) return `<td class="num"></td>`;
    const g = _growth(avgByYear[y], avgByYear[years[i - 1]]);
    return `<td class="num ${_growthClass(g)}">${_signedPct1(g)}</td>`;
  }).join("");
  const twoYrRow = years.map((y, i) => {
    if (i < 2) return `<td class="num"></td>`;
    const g = _growth(avgByYear[y], avgByYear[years[i - 2]]);
    return `<td class="num ${_growthClass(g)}">${_signedPct1(g)}</td>`;
  }).join("");
  const threeYrRow = years.map((y, i) => {
    if (i < 3) return `<td class="num"></td>`;
    const g = _growth(avgByYear[y], avgByYear[years[i - 3]]);
    return `<td class="num ${_growthClass(g)}">${_signedPct1(g)}</td>`;
  }).join("");

  const foot = `
    <tfoot>
      <tr class="agg-row">
        <td class="property-cell" colspan="${1 + COMP_META_COLS}">Avg Rent</td>
        ${years.map((y) => `<td class="num">${_fmtUsd(avgByYear[y])}</td>`).join("")}
      </tr>
      <tr class="growth-row">
        <td class="property-cell" colspan="${1 + COMP_META_COLS}">YoY Growth</td>
        ${yoyRow}
      </tr>
      <tr class="growth-row">
        <td class="property-cell" colspan="${1 + COMP_META_COLS}">2-Yr Growth</td>
        ${twoYrRow}
      </tr>
      <tr class="growth-row">
        <td class="property-cell" colspan="${1 + COMP_META_COLS}">3-Yr Growth</td>
        ${threeYrRow}
      </tr>
    </tfoot>`;

  table.innerHTML = head + `<tbody>${bodyRows}</tbody>` + foot;
}

function renderRentGrowthTable(id, selected, propsByKey, lookup, years) {
  const table = document.getElementById(id);
  if (!table) return;
  const head = `
    <thead>
      <tr>
        <th class="property-cell">Property</th>
        ${COMP_META_HEAD}
        ${years.map((y) => `<th class="num">${y}</th>`).join("")}
      </tr>
    </thead>`;
  // Per-property YoY growth per year (first year blank - no prior).
  // Track each year's collected growths to average in the footer.
  const yearGrowths = Object.fromEntries(years.map((y) => [y, []]));
  const bodyRows = selected.map((p) => {
    const cells = years.map((y, i) => {
      if (i === 0) return `<td class="num"></td>`;
      const curr = lookup[p.property_key]?.[y]?.avg_rent_per_bed;
      const prev = lookup[p.property_key]?.[years[i - 1]]?.avg_rent_per_bed;
      const g = _growth(curr, prev);
      if (g != null) yearGrowths[y].push(g);
      return `<td class="num ${_growthClass(g)}">${_signedPct1(g)}</td>`;
    }).join("");
    return `<tr>
      <td class="property-cell">${escapeHtml(p.property_name || "(unnamed)")}</td>
      ${compMetaCells(p)}
      ${cells}
    </tr>`;
  }).join("");

  const avgRow = years.map((y, i) => {
    if (i === 0) return `<td class="num"></td>`;
    const gs = yearGrowths[y];
    if (gs.length === 0) return `<td class="num"></td>`;
    const avg = gs.reduce((s, x) => s + x, 0) / gs.length;
    return `<td class="num ${_growthClass(avg)}">${_signedPct1(avg)}</td>`;
  }).join("");

  table.innerHTML = head
    + `<tbody>${bodyRows}</tbody>`
    + `<tfoot>
        <tr class="agg-row">
          <td class="property-cell" colspan="${1 + COMP_META_COLS}">Average Growth</td>
          ${avgRow}
        </tr>
      </tfoot>`;
}

function renderPctTable(id, selected, propsByKey, lookup, years, field) {
  const table = document.getElementById(id);
  if (!table) return;
  const head = `
    <thead>
      <tr>
        <th class="property-cell">Property</th>
        ${COMP_META_HEAD}
        ${years.map((y) => `<th class="num">${y}</th>`).join("")}
      </tr>
    </thead>`;
  const bodyRows = selected.map((p) => {
    return `<tr>
      <td class="property-cell">${escapeHtml(p.property_name || "(unnamed)")}</td>
      ${compMetaCells(p)}
      ${years.map((y) => {
        const r = lookup[p.property_key]?.[y];
        return `<td class="num">${_fmtPct0(r?.[field])}</td>`;
      }).join("")}
    </tr>`;
  }).join("");

  const avgByYear = {};
  years.forEach((y) => {
    const rows = selected.map((p) => lookup[p.property_key]?.[y]).filter(Boolean);
    avgByYear[y] = _bedWeighted(rows, field);
  });
  const yoyRow = years.map((y, i) => {
    if (i === 0) return `<td class="num"></td>`;
    const g = _growth(avgByYear[y], avgByYear[years[i - 1]]);
    return `<td class="num ${_growthClass(g)}">${_signedPct1(g)}</td>`;
  }).join("");
  const twoYrRow = years.map((y, i) => {
    if (i < 2) return `<td class="num"></td>`;
    const g = _growth(avgByYear[y], avgByYear[years[i - 2]]);
    return `<td class="num ${_growthClass(g)}">${_signedPct1(g)}</td>`;
  }).join("");

  const aggLabel = field === "prelease" ? "Average Pre-lease" : "Average Occupancy";
  table.innerHTML = head
    + `<tbody>${bodyRows}</tbody>`
    + `<tfoot>
        <tr class="agg-row">
          <td class="property-cell" colspan="${1 + COMP_META_COLS}">${aggLabel}</td>
          ${years.map((y) => `<td class="num">${_fmtPct1(avgByYear[y])}</td>`).join("")}
        </tr>
        <tr class="growth-row">
          <td class="property-cell" colspan="${1 + COMP_META_COLS}">YoY Growth</td>
          ${yoyRow}
        </tr>
        <tr class="growth-row">
          <td class="property-cell" colspan="${1 + COMP_META_COLS}">2-Yr Growth</td>
          ${twoYrRow}
        </tr>
      </tfoot>`;
}

/* ===== University Information tab ============================ */
/* Institutional stats from `university_info` (dbo.Schools_Denormal,
   latest CDS/IPEDS year per school) with enrollment headlines from
   `enrollment_history` (dbo.Enrollments_Manual - the current-year
   authority). Campus POI map pulls live from OpenStreetMap's Overpass
   API and caches per school in localStorage. Everything is lazy: built
   on first visit to the tab. */

/* Map rendering lives in uni-map.js (comp-map-style canvas with
   draggable call-outs and shaded districts). market.js owns the data
   layer: POI fetch (asset-first, live Overpass fallback), notability
   ranking, and district clustering. */

const POI_RADIUS_M = 3200;       // search radius around the campus pin
const POI_CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const POI_CAP_PER_CAT = 250;     // nearest-first cap per category
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const uniState = {
  initialized: false,
  schoolKey: null,
};

/* One entry per distinct school in this market (campus_locations carries
   one duplicate row per Schools_Denormal year - dedupe by school_key),
   joined to its university_info stats row. Anchor first, then by size. */
function uniSchools() {
  const infoByKey = new Map(
    (DATA.tables.university_info || [])
      .filter((r) => r.market_key === MARKET.market_key)
      .map((r) => [r.school_key, r]),
  );
  const seen = new Map();
  for (const c of CAMPUSES) {
    if (c.campus_lat == null || c.campus_lng == null) continue;
    if (!seen.has(c.school_key)) {
      seen.set(c.school_key, {
        school_key: c.school_key,
        university_name: c.university_name,
        ipeds_id: c.ipeds_id,
        lat: c.campus_lat,
        lng: c.campus_lng,
        enrollment: c.total_enrollment,
        info: infoByKey.get(c.school_key) || null,
      });
    }
  }
  return [...seen.values()].sort((a, b) => {
    const aAnchor = a.university_name === MARKET.anchor_university ? 1 : 0;
    const bAnchor = b.university_name === MARKET.anchor_university ? 1 : 0;
    if (aAnchor !== bAnchor) return bAnchor - aAnchor;
    return (b.enrollment || 0) - (a.enrollment || 0);
  });
}

function renderUniversityTab() {
  // Enrollment history lives on this tab now; (re)draw each time it is shown
  // so the charts size to the (previously hidden) container. renderEnrollment
  // destroys and recreates its charts, so calling it repeatedly is safe.
  renderEnrollment();

  if (uniState.initialized) return;
  uniState.initialized = true;

  const schools = uniSchools();
  if (!schools.length) {
    document.getElementById("uni-stats-grid").innerHTML =
      `<div class="empty-state">No tracked university for this market.</div>`;
    setUniMapStatus("No campus coordinates on file.");
    if (window.UniMap) UniMap.show(null);
    return;
  }

  const picker = document.getElementById("uni-picker");
  if (schools.length > 1) {
    picker.hidden = false;
    picker.innerHTML = schools.map((s) => `
      <button type="button" class="uni-pill" data-school="${s.school_key}">
        ${escapeHtml(s.university_name)}
      </button>`).join("");
    picker.querySelectorAll(".uni-pill").forEach((btn) => {
      btn.addEventListener("click", () => selectUniversity(Number(btn.dataset.school)));
    });
  }

  selectUniversity(schools[0].school_key);
}

function selectUniversity(schoolKey) {
  if (uniState.schoolKey === schoolKey) return;
  uniState.schoolKey = schoolKey;
  const school = uniSchools().find((s) => s.school_key === schoolKey);
  if (!school) return;

  document.querySelectorAll("#uni-picker .uni-pill").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.school) === schoolKey);
  });

  renderUniKpis(school);
  renderUniProfile(school);
  renderUniAdmissions(school);
  renderUniStats(school);
  renderUniMap(school);
}

/* Applications, Acceptance & Yield - acceptance (admitted/applied) and yield
   (enrolled/admitted) as bars on the % axis, total applications as a line on
   the right (thousands) axis. Data: tables.admissions_history (IPEDS ADM),
   joined by ipeds_id. Hidden when the school has no admissions history. */
function renderUniAdmissions(school) {
  const card = document.getElementById("uni-admissions-card");
  const canvas = document.getElementById("uni-admissions-chart");
  const subEl = document.getElementById("uni-admissions-sub");
  if (!card || !canvas || typeof Chart === "undefined") return;

  const rows = (DATA.tables.admissions_history || [])
    .filter((r) => r.ipeds_id === school.ipeds_id)
    .sort((a, b) => a.year_ - b.year_);

  if (uniAdmissionsChart) { uniAdmissionsChart.destroy(); uniAdmissionsChart = null; }
  if (rows.length === 0) { card.style.display = "none"; return; }
  card.style.display = "";

  if (subEl) {
    subEl.textContent =
      `${school.university_name} · first-time first-year · ${rows[0].year_}-${rows[rows.length - 1].year_} · source IPEDS ADM`;
  }

  const labels = rows.map((r) => `'${String(r.year_).slice(-2)}`);
  const accept = rows.map((r) => (r.applications ? (r.admitted / r.applications) * 100 : null));
  const yieldPct = rows.map((r) => (r.admitted ? (r.enrolled / r.admitted) * 100 : null));
  const appsK = rows.map((r) => (r.applications != null ? r.applications / 1000 : null));

  const barLabels = {
    anchor: "end", align: "end", offset: 1, clip: false,
    color: "#2b2825", font: { weight: 700, size: 10, family: "Pragmatica, sans-serif" },
    formatter: (v) => v == null ? "" : `${v.toFixed(0)}%`,
  };

  uniAdmissionsChart = new Chart(canvas.getContext("2d"), {
    data: {
      labels,
      datasets: [
        { type: "bar", label: "Enrollment Yield", data: yieldPct, yAxisID: "pct", order: 2,
          backgroundColor: "#3d8aa6", borderRadius: 2, categoryPercentage: 0.7, barPercentage: 0.9,
          datalabels: barLabels },
        { type: "bar", label: "Acceptance Rate", data: accept, yAxisID: "pct", order: 2,
          backgroundColor: "#a95818", borderRadius: 2, categoryPercentage: 0.7, barPercentage: 0.9,
          datalabels: barLabels },
        { type: "line", label: "Total Applications (Thousands)", data: appsK, yAxisID: "apps", order: 1,
          borderColor: "#16352e", backgroundColor: "#16352e", borderWidth: 3,
          pointRadius: 3, pointBackgroundColor: "#16352e", tension: 0.25,
          datalabels: { align: "top", offset: 4, clip: false, color: "#16352e",
            font: { weight: 700, size: 10, family: "Pragmatica, sans-serif" },
            formatter: (v) => v == null ? "" : v.toFixed(1) } },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 22, right: 6, left: 4, bottom: 4 } },
      plugins: {
        legend: {
          position: "bottom",
          labels: { font: { size: 11, family: "Pragmatica, sans-serif" }, color: "#2b2825",
                    boxWidth: 14, boxHeight: 10, padding: 14 },
        },
        tooltip: {
          callbacks: {
            label: (c) => c.dataset.yAxisID === "apps"
              ? `${c.dataset.label}: ${fmtInt(c.parsed.y * 1000)} applications`
              : `${c.dataset.label}: ${c.parsed.y == null ? "-" : c.parsed.y.toFixed(1) + "%"}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false },
             ticks: { font: { size: 12, weight: 700, family: "Pragmatica, sans-serif" }, color: "#2b2825" } },
        pct: { type: "linear", position: "left", beginAtZero: true, max: 100,
               grid: { color: "#f5efde", drawTicks: false }, border: { display: false },
               ticks: { font: { size: 10, family: "Pragmatica, sans-serif" }, color: "#5a544f",
                        stepSize: 20, callback: (v) => `${v}%` } },
        apps: { type: "linear", position: "right", beginAtZero: true,
                grid: { display: false }, border: { display: false },
                title: { display: true, text: "Applications (000s)",
                         font: { size: 10, family: "Pragmatica, sans-serif" }, color: "#5a544f" },
                ticks: { font: { size: 10, family: "Pragmatica, sans-serif" }, color: "#5a544f" } },
      },
    },
  });
}

/* Undergraduate Student Profile - the underwriting template (residency split,
   retention, on-campus, tuition, room & board) measured against Subtext
   targets, plus a residency doughnut. Built from university_info. Rows with no
   data source (International %, retention, Greek life, HS GPA) show n/a. */
function renderUniProfile(school) {
  const tableEl = document.getElementById("uni-profile-table");
  const subEl = document.getElementById("uni-profile-sub");
  if (!tableEl) return;
  const info = school.info;

  if (!info) {
    if (subEl) subEl.textContent = `${school.university_name} - no institutional stats on file.`;
    tableEl.innerHTML = `<tbody><tr><td class="property-cell">No institutional data for this campus.</td></tr></tbody>`;
    if (uniResidencyChart) { uniResidencyChart.destroy(); uniResidencyChart = null; }
    return;
  }
  if (subEl) {
    subEl.textContent =
      `${school.university_name} · undergraduate profile${info.enrollment_year ? ` · ${info.enrollment_year}` : ""}`
      + ` · vs Subtext targets · source dbo.Schools_Denormal`;
  }

  const ug = (info.enr_ft_undergrad || 0) + (info.enr_pt_undergrad || 0);
  const inPct = info.pct_in_state, outPct = info.pct_out_of_state;
  const inCt = (inPct != null && ug) ? Math.round(inPct * ug) : null;
  const outCt = (outPct != null && ug) ? Math.round(outPct * ug) : null;
  const roomBoard = ((info.rate_room_yearly || 0) + (info.rate_board_yearly || 0)) || null;
  const age = info.student_age_avg;

  const NA = `<span class="uni-na">n/a</span>`;
  const pctTxt = (p) => p == null ? NA : (p * 100).toFixed(1) + "%";
  // Target cell: state is "met" (dark), "miss" (red), or "na" (grey, no value).
  const tgt = (text, state) => `<td class="uni-target uni-target-${state}">${text}</td>`;
  const evalT = (val, pass) => val == null ? "na" : (pass ? "met" : "miss");
  // count | share | target row
  const split = (metric, ct, pct, targetCell) =>
    `<tr><td class="property-cell">${metric}</td><td>${ct == null ? NA : fmtInt(ct)}</td>` +
    `<td>${pctTxt(pct)}</td>${targetCell}</tr>`;
  // value spanning count+share | target row
  const span = (metric, val, targetCell) =>
    `<tr><td class="property-cell">${metric}</td><td colspan="2">${val}</td>${targetCell}</tr>`;

  const ageVal = age == null ? NA : (age % 1 === 0 ? String(Math.round(age)) : fmtNum(age, 1));

  const head = `<thead><tr><th class="property-cell" colspan="3">Undergraduate Student Profile</th><th>Targets</th></tr></thead>`;
  const body = [
    split("In-State", inCt, inPct, tgt("&lt;90%", evalT(inPct, inPct != null && inPct < 0.90))),
    split("Out-Of-State", outCt, outPct, tgt("&gt;10%", evalT(outPct, outPct != null && outPct > 0.10))),
    split("International Students", null, null, tgt("&gt;5%", "na")),
    span("Freshman Retention Rate", NA, tgt("&gt;85%", "na")),
    span("% of Undergrads in Greek Life", NA, "<td></td>"),
    span("Average Age of Undergrad", ageVal, tgt("&lt;22", evalT(age, age != null && age < 22))),
    span("% Living On-Campus (UG)", info.pct_on_campus != null ? `${(info.pct_on_campus * 100).toFixed(0)}%` : NA, "<td></td>"),
    span("In-State Tuition", fmtUsd(nzMoney(info.tuition_in_state)), "<td></td>"),
    span("Out-Of-State Tuition", fmtUsd(nzMoney(info.tuition_out_of_state)), "<td></td>"),
    span("Room &amp; Board (On-Campus)", fmtUsd(roomBoard), "<td></td>"),
    span("Avg HS GPA - Incoming Freshmen", NA, "<td></td>"),
  ].join("");
  tableEl.innerHTML = head + `<tbody>${body}</tbody>`;

  renderResidencyPie(inPct, outPct);
}

function renderResidencyPie(inPct, outPct) {
  const canvas = document.getElementById("uni-residency-pie");
  if (!canvas || typeof Chart === "undefined") return;
  if (uniResidencyChart) { uniResidencyChart.destroy(); uniResidencyChart = null; }
  if (inPct == null && outPct == null) {
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const labels = ["In-State", "Out-Of-State"];
  const data = [inPct || 0, outPct || 0];
  const total = data.reduce((s, v) => s + v, 0) || 1;
  uniResidencyChart = new Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: ["#16352e", "#a95818"],   // everest in-state, rust out
        borderColor: "#fff",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "52%",
      layout: { padding: 6 },
      plugins: {
        legend: {
          position: "bottom",
          labels: { font: { size: 11, family: "Pragmatica, sans-serif" }, color: "#2b2825",
                    boxWidth: 12, boxHeight: 12, padding: 10 },
        },
        tooltip: {
          callbacks: { label: (c) => `${c.label}: ${(c.parsed / total * 100).toFixed(1)}%` },
        },
        datalabels: {
          color: "#fff",
          font: { weight: 700, size: 12, family: "Pragmatica, sans-serif" },
          formatter: (v) => {
            const pct = v / total * 100;
            return pct < 4 ? "" : `${pct.toFixed(1)}%`;
          },
        },
      },
    },
  });
}

/* Latest + prior year from enrollment_history for one school. */
function uniEnrollmentLatest(ipeds) {
  const series = (DATA.tables.enrollment_history || [])
    .filter((r) => r.ipeds_id === ipeds)
    .sort((a, b) => a.year_ - b.year_);
  return {
    latest: series[series.length - 1] || null,
    prior: series[series.length - 2] || null,
  };
}

/* Money / income fields use 0 to mean "not reported". */
function nzMoney(v) {
  return v == null || v === 0 || isNaN(v) ? null : v;
}

function uniYoy(cur, prev) {
  if (cur == null || prev == null || !prev) return null;
  return cur / prev - 1;
}

function renderUniKpis(school) {
  const info = school.info || {};
  const { latest, prior } = uniEnrollmentLatest(school.ipeds_id);

  const totalYoy = uniYoy(latest?.total_enrollment, prior?.total_enrollment);
  const ftYoy = uniYoy(latest?.full_time_enrollment, prior?.full_time_enrollment);
  const bedsReported = info.beds_on_campus_reported || null;
  const bedsComputed = info.beds_on_campus_computed || null;
  const beds = bedsReported || bedsComputed;

  const kpis = [
    {
      label: "Total Enrollment",
      value: fmtInt(latest?.total_enrollment),
      sub: latest ? `${latest.year_}${totalYoy != null ? ` · ${deltaSpan(totalYoy)} YoY` : ""}` : "-",
    },
    {
      label: "Full-Time Enrollment",
      value: fmtInt(latest?.full_time_enrollment),
      sub: latest ? `${latest.year_}${ftYoy != null ? ` · ${deltaSpan(ftYoy)} YoY` : ""}` : "-",
    },
    {
      label: "On-Campus Beds",
      value: fmtInt(beds),
      sub: beds ? (bedsReported ? "reported" : "computed") : "not reported",
    },
    {
      label: "Admit Rate",
      value: fmtPct(info.admit_rate),
      sub: info.applied_first_year ? `${fmtInt(info.applied_first_year)} applied` : "-",
    },
    {
      label: "Tuition (In-State)",
      value: fmtUsd(nzMoney(info.tuition_in_state)),
      sub: nzMoney(info.tuition_out_of_state)
        ? `${fmtUsd(nzMoney(info.tuition_out_of_state))} out-of-state` : "-",
    },
  ];

  document.getElementById("uni-kpis").innerHTML = kpis.map((k) => `
    <div class="kpi">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${k.value}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join("");
}

function uniStatRow(label, value, hint) {
  return `<div class="uni-stat-row"${hint ? ` title="${escapeHtml(hint)}"` : ""}>
    <dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

function renderUniStats(school) {
  const info = school.info;
  const sub = document.getElementById("uni-stats-sub");
  const grid = document.getElementById("uni-stats-grid");

  if (!info) {
    sub.textContent = `${school.university_name} - no institutional stats on file.`;
    grid.innerHTML = `<div class="empty-state">No Schools_Denormal row for this campus.</div>`;
    return;
  }

  sub.textContent =
    `${school.university_name} · ${info.is_public ? "Public" : "Private"} · ` +
    `latest reported year ${info.enrollment_year} · source dbo.Schools_Denormal`;

  const { latest, prior } = uniEnrollmentLatest(school.ipeds_id);
  const trend = (DATA.tables.enrollment_trend || []).find((r) => r.ipeds_id === school.ipeds_id);

  /* Enrollment - headline numbers from Enrollments_Manual when we have
     them (current-year authority); Schools_Denormal as fallback. */
  const enrRows = latest ? [
    uniStatRow("Total enrollment", `${fmtInt(latest.total_enrollment)} <span class="uni-stat-note">${latest.year_}</span>`),
    uniStatRow("Full-time enrollment", fmtInt(latest.full_time_enrollment)),
    uniStatRow("Undergraduate", fmtInt(latest.undergrad_enrollment)),
    uniStatRow("Graduate", fmtInt(latest.graduate_enrollment)),
    uniStatRow("Freshman class", fmtInt(latest.freshman_enrollment)),
    uniStatRow("YoY change (total)", deltaSpan(uniYoy(latest.total_enrollment, prior?.total_enrollment))),
    uniStatRow("5-yr CAGR (total)", deltaSpan(trend?.cagr_5yr)),
  ] : [
    uniStatRow("Total enrollment", `${fmtInt(info.enrollment_total)} <span class="uni-stat-note">${info.enrollment_year}</span>`),
    uniStatRow("Full-time undergrad", fmtInt(info.enr_ft_undergrad)),
    uniStatRow("Part-time undergrad", fmtInt(info.enr_pt_undergrad)),
    uniStatRow("Full-time graduate", fmtInt(info.enr_ft_grad)),
    uniStatRow("Part-time graduate", fmtInt(info.enr_pt_grad)),
  ];

  /* On-campus housing */
  const housingChips = [
    ["has_dorms_coed", "Coed dorms"],
    ["has_dorms_men", "Men's dorms"],
    ["has_dorms_women", "Women's dorms"],
    ["has_apts_single", "Single-student apts"],
    ["has_apts_married", "Married housing"],
    ["has_housing_greek", "Greek housing"],
    ["has_housing_intl", "International"],
    ["has_housing_disabled", "Accessible"],
    ["has_housing_coop", "Co-op"],
  ].filter(([k]) => info[k]).map(([, l]) => `<span class="uni-chip">${l}</span>`).join("");

  const housingRows = [
    uniStatRow("On-campus beds (reported)", fmtInt(info.beds_on_campus_reported || null)),
    uniStatRow("On-campus beds (computed)", fmtInt(info.beds_on_campus_computed || null),
      "Computed from enrollment x share of undergrads living on campus"),
    uniStatRow("Undergrads on campus", fmtPct(info.pct_on_campus)),
    uniStatRow("Undergrads off campus", fmtPct(info.pct_off_campus)),
    uniStatRow("Room rate (academic yr)", fmtUsd(nzMoney(info.rate_room_yearly))),
    uniStatRow("Board rate (academic yr)", fmtUsd(nzMoney(info.rate_board_yearly))),
    uniStatRow("Room rate (monthly avg)", fmtUsd(nzMoney(info.rate_room_monthly))),
    uniStatRow("On- vs off-campus cost delta", nzMoney(info.cost_housing_delta) != null
      ? fmtUsd(info.cost_housing_delta) : "-",
      "Annual on-campus housing cost minus the off-campus equivalent"),
    housingChips ? `<div class="uni-stat-row uni-stat-row-chips"><dt>Housing offered</dt><dd>${housingChips}</dd></div>` : "",
  ];

  /* Admissions funnel */
  const yieldRate = info.enrolled_first_year && info.admitted_first_year
    ? info.enrolled_first_year / info.admitted_first_year : null;
  const admissionsRows = [
    uniStatRow("Applied (first-year)", fmtInt(info.applied_first_year)),
    uniStatRow("Admitted (first-year)", fmtInt(info.admitted_first_year)),
    uniStatRow("Admit rate", fmtPct(info.admit_rate)),
    uniStatRow("Enrolled (first-year)", fmtInt(info.enrolled_first_year)),
    uniStatRow("Yield", fmtPct(yieldRate), "Enrolled / admitted"),
    uniStatRow("Applied (transfer)", fmtInt(info.applied_transfer)),
    uniStatRow("Transfer admit rate", fmtPct(info.transfer_admit_rate)),
    uniStatRow("Enrolled (transfer)", fmtInt(info.enrolled_transfer)),
  ];

  /* Cost of attendance */
  const costRows = [
    uniStatRow("Tuition (in-state)", fmtUsd(nzMoney(info.tuition_in_state))),
    uniStatRow("Tuition (out-of-state)", fmtUsd(nzMoney(info.tuition_out_of_state))),
    uniStatRow("Cost / credit hour (in-state)", fmtUsd(nzMoney(info.credit_hour_in_state))),
    uniStatRow("Cost / credit hour (out-of-state)", fmtUsd(nzMoney(info.credit_hour_out_of_state))),
  ];

  /* Student profile */
  const profileRows = [
    uniStatRow("Undergrads in-state", fmtPct(info.pct_in_state)),
    uniStatRow("Undergrads out-of-state", fmtPct(info.pct_out_of_state)),
    uniStatRow("Average student age", info.student_age_avg ? fmtNum(info.student_age_avg, 0) : "-"),
    uniStatRow("Parent income (avg)", fmtUsd(nzMoney(info.parent_income_avg))),
    uniStatRow("Parent income (median)", fmtUsd(nzMoney(info.parent_income_med))),
    uniStatRow("Control", info.is_public ? "Public" : "Private"),
  ];

  const groups = [
    ["Enrollment", enrRows, latest ? "Enrollments_Manual" : "Schools_Denormal"],
    ["On-Campus Housing", housingRows, null],
    ["Admissions", admissionsRows, null],
    ["Cost of Attendance", costRows, null],
    ["Student Profile", profileRows, null],
  ];

  grid.innerHTML = groups.map(([title, rows, note]) => `
    <div class="uni-stat-group">
      <div class="uni-stat-group-title">${title}${note ? `<span class="uni-stat-group-note">${note}</span>` : ""}</div>
      <dl class="uni-stat-list">${rows.join("")}</dl>
    </div>`).join("");
}

/* ----- Campus POI map (rendered by uni-map.js) ----------------- */

function renderUniMap(school) {
  if (window.UniMap) UniMap.show(school);
}

function setUniMapStatus(text) {
  const el = document.getElementById("uni-map-sub");
  if (el) el.textContent = text;
}

/* ----- callouts: best-known POIs, comp-map style --------------- */

/* Highest notability score first (distance to campus breaks ties),
   deduped by name so multi-part buildings appear once. */
function pickTopPois(list, cap, school) {
  const d = (p) => poiDistM(p, { lat: school.lat, lng: school.lng });
  const seen = new Set();
  return [...list]
    .sort((a, b) => (b.score || 0) - (a.score || 0) || d(a) - d(b))
    .filter((p) => {
      const k = p.name.toLowerCase();
      if (p.name === "(unnamed)" || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, cap);
}

function poiDistM(a, b) {
  const dy = (a.lat - b.lat) * 111320;
  const dx = (a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dx, dy);
}

/* Greek-letter org names: "Sigma Chi", "Kappa Kappa Gamma", ... */
const GREEK_WORDS = "Alpha|Beta|Gamma|Delta|Epsilon|Zeta|Eta|Theta|Iota|Kappa|Lambda|Mu|Nu|Xi|Omicron|Pi|Rho|Sigma|Tau|Upsilon|Phi|Chi|Psi|Omega";

/* Equality-only clauses with the tag filter FIRST: Overpass value-regex
   filters can't use the (key,value) index and scan the key worldwide,
   which blows any sane timeout. Even so, a live per-campus query takes
   minutes - this is the FALLBACK path; the normal path is the static
   asset prefetched by fetch-campus-pois.py. */
function overpassQuery(lat, lng) {
  const around = `(around:${POI_RADIUS_M},${lat},${lng})`;
  const clauses = [
    ["building", "university", true], ["building", "college", true],
    ["building", "dormitory", true], ["amenity", "library", true],
    ["historic", "monument", true], ["historic", "memorial", true],
    ["tourism", "attraction", true], ["tourism", "artwork", true],
    ["leisure", "stadium", true], ["building", "stadium", true],
    ["leisure", "sports_centre", true],
    ["club", "fraternity", false], ["club", "sorority", false],
    ["amenity", "fraternity", false], ["amenity", "sorority", false],
    ["building", "fraternity", false], ["building", "sorority", false],
    ["amenity", "bar", true], ["amenity", "pub", true],
    ["amenity", "nightclub", true], ["amenity", "biergarten", true],
  ].map(([k, v, named]) =>
    `  nwr["${k}"="${v}"]${named ? `["name"]` : ""}${around};`,
  ).join("\n");
  return `[out:json][timeout:180];\n(\n${clauses}\n);\nout tags center bb qt;`;
}

/* Tag-based classification; order matters (most specific first). */
function classifyPoi(tags) {
  const amenity = tags.amenity || "";
  const name = tags.name || "";
  if (/^(bar|pub|nightclub|biergarten)$/.test(amenity)) return "nightlife";
  if (/^(fraternity|sorority)$/.test(tags.club || "") ||
      /^(fraternity|sorority)$/.test(amenity) ||
      /fraternity|sorority/i.test(name) ||
      (tags.building && new RegExp(`^(${GREEK_WORDS}) (${GREEK_WORDS})`).test(name))) return "greek";
  if (tags.leisure === "stadium" || tags.leisure === "sports_centre" ||
      tags.building === "stadium") return "athletics";
  if (/^(monument|memorial)$/.test(tags.historic || "") ||
      /^(attraction|artwork)$/.test(tags.tourism || "")) return "landmark";
  if (tags.building === "dormitory") return "residence";
  if (/^(university|college)$/.test(tags.building || "") || amenity === "library") return "academic";
  return null;
}

async function fetchCampusPois(school) {
  // 1. Static asset prefetched by fetch-campus-pois.py - the normal path.
  try {
    const res = await fetch(`assets/campus-pois/${school.school_key}.json`, { cache: "no-cache" });
    if (res.ok) {
      const asset = await res.json();
      if (Array.isArray(asset.pois)) return asset.pois;
    }
  } catch { /* fall through to live Overpass */ }

  // 2. Browser cache of a previous live fetch.
  const cacheKey = `uniPoi.v2.${school.school_key}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (cached && Date.now() - cached.t < POI_CACHE_TTL_MS) return cached.pois;
  } catch { /* bad cache entry; refetch */ }

  // 3. Live Overpass - slow (the query takes minutes server-side).
  setUniMapStatus("No prefetched POI file for this campus - querying OpenStreetMap live (can take a few minutes) ...");
  const query = overpassQuery(school.lat, school.lng);
  let lastErr = null;
  let json = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(190000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!json) throw lastErr || new Error("Overpass unavailable");

  const seen = new Set();
  const pois = [];
  for (const el of json.elements || []) {
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const tags = el.tags || {};
    const b = el.bounds;
    const lat = el.lat ?? el.center?.lat ?? (b ? (b.minlat + b.maxlat) / 2 : null);
    const lng = el.lon ?? el.center?.lon ?? (b ? (b.minlon + b.maxlon) / 2 : null);
    if (lat == null || lng == null) continue;
    const cat = classifyPoi(tags);
    if (!cat) continue;
    const name = tags.name || tags["name:en"] || "(unnamed)";
    const sub = tags.amenity || tags.leisure || tags.historic || tags.tourism || tags.building || "";
    // mirror of the notability score in fetch-campus-pois.py
    let area = 0;
    if (b) {
      const dy = (b.maxlat - b.minlat) * 111320;
      const dx = (b.maxlon - b.minlon) * 111320 * Math.cos(lat * Math.PI / 180);
      area = Math.min(Math.abs(dx * dy), 150000);
    }
    const wiki = tags.wikipedia ? 2 : (tags.wikidata ? 1 : 0);
    pois.push({ cat, name, lat, lng, sub, score: Math.round(wiki * 30000 + area) });
  }

  // nearest-first cap per category so dense downtowns don't swamp the map
  const dist = (p) => {
    const dx = (p.lng - school.lng) * Math.cos(school.lat * Math.PI / 180);
    const dy = p.lat - school.lat;
    return dx * dx + dy * dy;
  };
  const capped = [];
  for (const cat of new Set(pois.map((p) => p.cat))) {
    capped.push(...pois.filter((p) => p.cat === cat)
      .sort((a, b) => dist(a) - dist(b))
      .slice(0, POI_CAP_PER_CAT));
  }

  try {
    localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), pois: capped }));
  } catch { /* quota exceeded - live without the cache */ }
  return capped;
}

