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
// Per-table sort state: the comp-set table defaults to year built
// (newest first); the all-properties table keeps pre-lease.
let propSortStates = {
  "properties-all":   { col: "prelease",  dir: "desc" },
  "properties-comps": { col: "yearBuilt", dir: "desc" },
};
let map = null;
let propertyMarkers = new Map();  // market map: property_key → leaflet marker
let compSelection = new Set();  // property_keys currently checked on Comps tab
let compSelectionInit = false;  // defaults applied once; user edits persist after
let compCharts = {};  // canvas id → Chart instance

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

  setFreshness();
  renderHeader();
  renderKpis();
  renderQualifiers();
  renderProperties();
  bindPropertySort();
  renderLegend();
  renderPerformance();
  renderEnrollment();
  bindTabs();
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
  pipeColors: {
    existing:           "#2b2825",  // slate
    lease_up:           "#16352e",  // everest
    under_construction: "#a95818",  // rust
    planned:            "#b6b1ab",  // slate30
  },
};

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
  const myHistory = history.filter((r) => r.market_key === MARKET.market_key)
    .sort((a, b) => a.year_ - b.year_);
  const years = myHistory.map((r) => r.year_);

  // Treat 0 as missing for these metrics - a real student-housing market
  // never has $0 rent or 0% occupancy/prelease; zeros mean "market not yet
  // tracked at this snapshot."
  const cleanZero = (v) => (v == null || v === 0) ? null : Number(v);

  function s30YearMean(field) {
    const byYear = new Map();
    for (const r of history) {
      if (!s30Keys.has(r.market_key)) continue;
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

  function renderTimeSeries(canvasId, field, valueFmt, { transform = (v) => v, yMax = null } = {}) {
    const ctx = document.getElementById(canvasId);
    if (!ctx || !years.length) return;
    const myData = myHistory.map((r) => {
      const v = cleanZero(r[field]);
      return v == null ? null : transform(v);
    });
    const s30Data = s30YearMean(field).map((v) => v == null ? null : transform(v));
    new Chart(ctx, {
      type: "bar",
      data: {
        labels: years.map(String),
        datasets: [
          { label: MARKET.anchor_university || "This market", data: myData, backgroundColor: PERF.anchorColor, borderRadius: 2,
            categoryPercentage: 0.78, barPercentage: 0.95 },
          { label: "Subtext-30 avg",                          data: s30Data, backgroundColor: PERF.benchColor, borderRadius: 2,
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
          y: { display: false, beginAtZero: true, max: yMax },
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
    const myRentSeries = myHistory.map((r) => cleanZero(r.avg_rent_per_bed));
    const s30RentSeries = s30YearMean("avg_rent_per_bed");
    const growthYears = years.slice(1);
    const myGrowth = growthYears.map((_, i) => {
      const a = myRentSeries[i + 1], b = myRentSeries[i];
      return (a != null && b != null && b !== 0) ? (a - b) / b : null;
    });
    const s30Growth = growthYears.map((_, i) => {
      const a = s30RentSeries[i + 1], b = s30RentSeries[i];
      return (a != null && b != null && b !== 0) ? (a - b) / b : null;
    });
    new Chart(rentGrowthCtx, {
      type: "bar",
      data: {
        labels: growthYears.map(String),
        datasets: [
          { label: MARKET.anchor_university || "This market", data: myGrowth.map((v) => v == null ? null : v * 100),  backgroundColor: PERF.anchorColor, borderRadius: 2,
            categoryPercentage: 0.78, barPercentage: 0.95 },
          { label: "Subtext-30 avg",                          data: s30Growth.map((v) => v == null ? null : v * 100), backgroundColor: PERF.benchColor, borderRadius: 2,
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
          y: { display: false, suggestedMin: -5 },
        },
      },
    });
  }

  // 5) Penetration benchmark ------------------------------------------
  const penRows = s30Rows("scorecard").map((r) => r.penetration_ratio).filter((v) => v != null);
  const s30Pen = mean(penRows);
  const myPen = MARKET.penetration_ratio;
  const penCtx = document.getElementById("perf-penetration");
  if (penCtx && (myPen != null || s30Pen != null)) {
    new Chart(penCtx, {
      type: "bar",
      data: {
        labels: [MARKET.anchor_university || "This market", "Subtext-30 avg"],
        datasets: [{
          data: [myPen, s30Pen],
          backgroundColor: [PERF.anchorColor, PERF.benchColor],
          borderRadius: 3,
          categoryPercentage: 0.55,
          barPercentage: 0.9,
        }],
      },
      options: perfBaseOpts({ valueFmt: (v) => v == null ? "-" : fmtPct(v, 1) }),
    });
  }

  // 5) Bed supply: existing + pipeline ---------------------------------
  // Two stacked horizontal bars: this market on top, Subtext-30 avg on bottom.
  const pipeMap = new Map(DATA.tables.pipeline_beds.map((r) => [r.market_key, r]));
  const myPipe = pipeMap.get(MARKET.market_key) || {};
  const myExisting = MARKET.existing_beds || 0;
  const myLease = myPipe.beds_lease_up || 0;
  const myUC = myPipe.beds_under_construction || 0;
  const myPlanned = myPipe.beds_planned || 0;

  const s30Pipe = s30Rows("pipeline_beds");
  const s30Existing = mean(s30Rows("existing_beds").map((r) => r.existing_beds));
  const s30Lease = mean(s30Pipe.map((r) => r.beds_lease_up));
  const s30UC = mean(s30Pipe.map((r) => r.beds_under_construction));
  const s30Planned = mean(s30Pipe.map((r) => r.beds_planned));

  // 6) Pre-leasing velocity: multi-cycle line for THIS market ---------
  const velRows = (DATA.tables.prelease_velocity || []).filter((r) => r.market_key === MARKET.market_key);
  const cycles = [...new Set(velRows.map((r) => r.leasing_cycle))].sort((a, b) => a - b);
  // Keep the chart focused on the most recent three cycles (older lines
  // crowd the view and obscure the YoY comparison that matters).
  const recentCycles = cycles.slice(-3);
  // Older → newer: slate → rust → everest. Latest cycle is emphasized.
  const palette = ["#b6b1ab", "#a95818", "#16352e"];
  const velCtx = document.getElementById("perf-velocity");
  if (velCtx && recentCycles.length) {
    const datasets = recentCycles.map((cycle, i) => {
      const isLatest = i === recentCycles.length - 1;
      const color = palette[(palette.length - recentCycles.length + i + palette.length) % palette.length];
      const data = velRows.filter((r) => r.leasing_cycle === cycle)
        .sort((a, b) => a.week_of_cycle - b.week_of_cycle)
        .map((r) => ({ x: r.week_of_cycle, y: r.prelease_pct * 100 }));
      return {
        label: `Cycle ${cycle}`,
        data,
        borderColor: color,
        backgroundColor: color,
        borderWidth: isLatest ? 3 : 1.75,
        pointRadius: isLatest ? 3 : 1.5,
        pointBackgroundColor: color,
        tension: 0.25,
      };
    });
    new Chart(velCtx, {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "top", align: "end",
            labels: { boxWidth: 16, boxHeight: 4, font: { size: 11, weight: 600, family: "Pragmatica, sans-serif" }, color: "#2b2825", padding: 12 },
          },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%` } },
          datalabels: { display: false },
        },
        layout: { padding: { top: 4, right: 16, left: 8, bottom: 0 } },
        scales: {
          x: { type: "linear", min: 1, max: 53,
               ticks: { stepSize: 8, font: { size: 11, weight: 600, family: "Pragmatica, sans-serif" }, color: "#5a544f", callback: (v) => `Wk ${v}` },
               grid: { display: false },
               border: { color: "#ede5cf" } },
          y: { min: 0, max: 100,
               ticks: { stepSize: 20, font: { size: 11, weight: 600, family: "Pragmatica, sans-serif" }, color: "#5a544f", callback: (v) => `${v}%` },
               grid: { color: "#f5efde", drawTicks: false },
               border: { display: false } },
        },
      },
    });
  }

  const supplyCtx = document.getElementById("perf-supply");
  if (supplyCtx) {
    new Chart(supplyCtx, {
      type: "bar",
      data: {
        labels: [MARKET.anchor_university || "This market", "Subtext-30 avg"],
        datasets: [
          { label: "Existing",           backgroundColor: PERF.pipeColors.existing,           data: [myExisting, s30Existing], borderRadius: 2 },
          { label: "Lease-up",           backgroundColor: PERF.pipeColors.lease_up,           data: [myLease,    s30Lease],    borderRadius: 2 },
          { label: "Under construction", backgroundColor: PERF.pipeColors.under_construction, data: [myUC,       s30UC],       borderRadius: 2 },
          { label: "Planned",            backgroundColor: PERF.pipeColors.planned,            data: [myPlanned,  s30Planned],  borderRadius: 2 },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { font: { size: 11, weight: 600, family: "Pragmatica, sans-serif" }, color: "#2b2825", boxWidth: 12, boxHeight: 12, padding: 14 } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtInt(c.parsed.x)} beds` } },
          datalabels: {
            color: "#fff",
            font: { weight: 700, size: 11, family: "Pragmatica, sans-serif" },
            formatter: (v) => (v != null && v >= 200) ? fmtInt(v) : "",  // hide labels on tiny segments
          },
        },
        layout: { padding: { top: 4, right: 12, left: 4, bottom: 4 } },
        scales: {
          x: { stacked: true, display: false, beginAtZero: true },
          y: { stacked: true, grid: { display: false, drawBorder: false },
               border: { display: false },
               ticks: { font: { size: 13, weight: 600, family: "Pragmatica, sans-serif" }, color: "#2b2825" } },
        },
      },
    });
  }
}

/* ----- Helpers ----------------------------------------------- */

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
    return `
      <li class="qual-row qual-${state}">
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

function campusMarkerIcon(isAnchor, marketKey) {
  // If we have a logo for this market AND this is the anchor campus,
  // use the logo inside a circular badge. Otherwise fall back to the SVG icon.
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
  const allCampuses = CAMPUSES.filter(
    (c) => c.campus_lat != null && c.campus_lng != null,
  );

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
      icon: campusMarkerIcon(isAnchor, MARKET.market_key),
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

  // Comp Map Generator (comp-map.js) tracks the same selection.
  if (window.CompMap) window.CompMap.refresh();
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

/* mode "callout": only the best-known few, each with a comp-map-style
   call-out box (ranked by the prefetcher's notability score - Wikipedia/
   Wikidata link + footprint size). mode "zone": no individual pins;
   venue clusters become shaded district outlines instead. */
const POI_CATS = [
  { key: "academic",  label: "Academic buildings",    color: "#16352e", mode: "callout", cap: 8 },
  { key: "landmark",  label: "Monuments + landmarks", color: "#a95818", mode: "callout", cap: 5 },
  { key: "athletics", label: "Athletics",             color: "#8c1d18", mode: "callout", cap: 5 },
  { key: "greek",     label: "Greek life",            color: "#6d4aa0", mode: "zone" },
  { key: "nightlife", label: "Nightlife",             color: "#c79830", mode: "zone" },
];
const POI_ZONE_EPS_M = 280;   // venues closer than this merge into one district

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
  map: null,
  campusMarker: null,
  poiLayers: new Map(),    // cat key -> L.layerGroup
  poiHidden: new Set(),    // cat keys the user unticked
  poiForSchool: null,      // school_key the current POI layers belong to
  poiFetchSeq: 0,          // stale-response guard when switching schools fast
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
  if (uniState.initialized) {
    if (uniState.map) uniState.map.invalidateSize();
    return;
  }
  uniState.initialized = true;

  const schools = uniSchools();
  if (!schools.length) {
    document.getElementById("uni-stats-grid").innerHTML =
      `<div class="empty-state">No tracked university for this market.</div>`;
    document.getElementById("uni-map").innerHTML =
      `<div class="empty-state">No campus coordinates on file.</div>`;
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
  renderUniStats(school);
  renderUniMap(school);
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

/* ----- Campus POI map ---------------------------------------- */

async function renderUniMap(school) {
  const container = document.getElementById("uni-map");
  if (!container) return;

  if (typeof L === "undefined") {
    await new Promise((r) => window.addEventListener("load", r, { once: true }));
    if (typeof L === "undefined") {
      container.innerHTML = `<div class="empty-state">Map library failed to load.</div>`;
      return;
    }
  }

  if (!uniState.map) {
    uniState.map = L.map("uni-map", {
      center: [school.lat, school.lng],
      zoom: 15,
      scrollWheelZoom: true,
      preferCanvas: true,    // hundreds of POI circle markers
      minZoom: 8,
      worldCopyJump: false,
      maxBounds: [[-85, -180], [85, 180]],
      maxBoundsViscosity: 1,
    });
    const baseLayers = {
      "Street": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors", maxZoom: 19, noWrap: true,
      }),
      "Satellite": L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { attribution: "Tiles © Esri, Maxar, Earthstar Geographics", maxZoom: 19, noWrap: true },
      ),
      "Light": L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png", {
        attribution: "© OSM · © CARTO", subdomains: "abcd", maxZoom: 19, noWrap: true,
      }),
    };
    baseLayers.Street.addTo(uniState.map);
    L.control.layers(baseLayers, null, { position: "topright", collapsed: true }).addTo(uniState.map);
    addFullscreenControl(uniState.map);

    // Campus boundary is a market-level asset; add once.
    try {
      const gjRes = await fetch(`assets/campus-boundaries/${MARKET.market_key}.geojson`, { cache: "no-cache" });
      if (gjRes.ok) {
        const gj = await gjRes.json();
        L.geoJSON(gj, {
          style: { color: "#d32f2f", weight: 2, opacity: 0.95, fillColor: "#d32f2f", fillOpacity: 0.10 },
          interactive: false,
        }).addTo(uniState.map);
      }
    } catch { /* missing boundary file is fine */ }
  } else {
    uniState.map.setView([school.lat, school.lng], 15);
  }
  uniState.map.invalidateSize();

  if (uniState.campusMarker) uniState.campusMarker.remove();
  uniState.campusMarker = L.marker([school.lat, school.lng], {
    icon: campusMarkerIcon(school.university_name === MARKET.anchor_university, MARKET.market_key),
    zIndexOffset: 1000,
  }).addTo(uniState.map).bindPopup(
    `<div class="map-popup"><div class="map-popup-head">
       <div class="map-popup-eyebrow">Campus</div>
       <div class="map-popup-title">${escapeHtml(school.university_name)}</div>
     </div></div>`,
    { className: "market-popup-wrapper", maxWidth: 280 },
  );

  loadUniPois(school);
}

function setUniMapStatus(text) {
  const el = document.getElementById("uni-map-sub");
  if (el) el.textContent = text;
}

async function loadUniPois(school) {
  if (uniState.poiForSchool === school.school_key) return;
  const seq = ++uniState.poiFetchSeq;

  // clear the previous school's layers
  for (const lg of uniState.poiLayers.values()) lg.remove();
  uniState.poiLayers.clear();
  document.getElementById("uni-map-toggles").innerHTML = "";

  setUniMapStatus("Loading points of interest from OpenStreetMap ...");
  let pois = null;
  try {
    pois = await fetchCampusPois(school);
  } catch (err) {
    if (seq !== uniState.poiFetchSeq) return;
    setUniMapStatus(`Couldn't load points of interest (${err.message || err}). Re-open the tab to retry.`);
    uniState.poiForSchool = null;
    return;
  }
  if (seq !== uniState.poiFetchSeq) return;   // user switched schools mid-fetch
  uniState.poiForSchool = school.school_key;

  const byCat = new Map(POI_CATS.map((c) => [c.key, []]));
  for (const p of pois) byCat.get(p.cat)?.push(p);

  const counts = new Map();
  let calloutTotal = 0;
  let zoneTotal = 0;
  for (const cat of POI_CATS) {
    const list = byCat.get(cat.key);
    const lg = L.layerGroup();
    if (cat.mode === "callout") {
      const top = pickTopPois(list, cat.cap, school);
      top.forEach((p) => lg.addLayer(calloutMarker(p, cat, school)));
      counts.set(cat.key, top.length);
      calloutTotal += top.length;
    } else {
      const zones = buildPoiZones(list);
      let venues = 0;
      for (const zone of zones) {
        addZoneLayers(zone, cat, lg);
        venues += zone.venues.length;
        zoneTotal += 1;
      }
      counts.set(cat.key, venues);
    }
    uniState.poiLayers.set(cat.key, lg);
    if (!uniState.poiHidden.has(cat.key)) lg.addTo(uniState.map);
  }

  renderUniPoiToggles(counts);
  setUniMapStatus(
    `${calloutTotal} campus landmarks called out · ${zoneTotal} shaded Greek life / nightlife districts · OpenStreetMap`,
  );
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

/* The box points away from the campus pin so call-outs fan outward. */
function calloutMarker(p, cat, school) {
  const side = p.lng >= school.lng ? "right" : "left";
  const icon = L.divIcon({
    className: "uni-callout-wrap",
    html: `<div class="uni-callout uni-callout-${side}" style="--cat-color:${cat.color}">
      <span class="uni-callout-dot"></span><span class="uni-callout-line"></span>
      <span class="uni-callout-box">${escapeHtml(p.name)}</span>
    </div>`,
    iconSize: [0, 0],
  });
  const m = L.marker([p.lat, p.lng], { icon, zIndexOffset: 800 });
  m.bindPopup(`
    <div class="map-popup"><div class="map-popup-head">
      <div class="map-popup-eyebrow" style="color:${cat.color}">${cat.label}</div>
      <div class="map-popup-title">${escapeHtml(p.name)}</div>
    </div>${p.sub ? `<div class="map-popup-body"><div class="map-popup-row"><span class="map-popup-row-label">${escapeHtml(p.sub)}</span></div></div>` : ""}</div>`,
    { className: "market-popup-wrapper", maxWidth: 280 });
  return m;
}

/* ----- zones: shaded district outlines ------------------------- */

function poiDistM(a, b) {
  const dy = (a.lat - b.lat) * 111320;
  const dx = (a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dx, dy);
}

/* Greedy single-link clustering, then keep clusters of 3+ venues
   (else the map litters with one-bar circles). If nothing qualifies,
   keep the largest cluster so small towns still get their district. */
function buildPoiZones(list) {
  const clusters = [];
  for (const p of list) {
    const home = clusters.find((c) => c.some((q) => poiDistM(p, q) < POI_ZONE_EPS_M));
    if (home) home.push(p); else clusters.push([p]);
  }
  clusters.sort((a, b) => b.length - a.length);
  let kept = clusters.filter((c) => c.length >= 3);
  if (!kept.length && clusters.length) kept = [clusters[0]];
  return kept.map((venues) => ({ venues, hull: expandedHull(venues) }));
}

/* Monotone-chain convex hull (lng as x, lat as y), padded outward from
   the centroid so the shading breathes around the venues. */
function expandedHull(venues, padM = 70) {
  const pts = venues.map((p) => ({ x: p.lng, y: p.lat }));
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (iter) => {
    const out = [];
    for (const p of iter) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  const hull = pts.length >= 3 ? [...half(pts), ...half([...pts].reverse())] : pts;
  if (hull.length < 3) return null;
  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
  const padLat = padM / 111320;
  return hull.map((p) => {
    const dx = p.x - cx, dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const padLng = padLat / Math.cos(p.y * Math.PI / 180);
    return [p.y + (dy / len) * padLat, p.x + (dx / len) * padLng];
  });
}

function addZoneLayers(zone, cat, lg) {
  const { venues, hull } = zone;
  const clat = venues.reduce((s, p) => s + p.lat, 0) / venues.length;
  const clng = venues.reduce((s, p) => s + p.lng, 0) / venues.length;
  const style = {
    color: cat.color, weight: 2, dashArray: "6 4", opacity: 0.85,
    fillColor: cat.color, fillOpacity: 0.16, interactive: true,
  };
  const shape = hull
    ? L.polygon(hull, style)
    : L.circle([clat, clng], { radius: 120, ...style });
  const names = venues.filter((p) => p.name !== "(unnamed)").map((p) => p.name);
  const listed = names.slice(0, 10).map(escapeHtml).join("<br>")
    + (names.length > 10 ? `<br>… and ${names.length - 10} more` : "");
  shape.bindPopup(`
    <div class="map-popup"><div class="map-popup-head">
      <div class="map-popup-eyebrow" style="color:${cat.color}">${cat.label} district</div>
      <div class="map-popup-title">${venues.length} venue${venues.length === 1 ? "" : "s"}</div>
    </div><div class="map-popup-body"><div class="map-popup-row"><span class="map-popup-row-label">${listed}</span></div></div></div>`,
    { className: "market-popup-wrapper", maxWidth: 280 });
  lg.addLayer(shape);
  lg.addLayer(L.marker([clat, clng], {
    icon: L.divIcon({
      className: "uni-zone-label-wrap",
      html: `<div class="uni-zone-label" style="--cat-color:${cat.color}">${cat.label} · ${venues.length}</div>`,
      iconSize: [0, 0],
    }),
    interactive: false,
    zIndexOffset: 700,
  }));
}

function renderUniPoiToggles(counts) {
  const wrap = document.getElementById("uni-map-toggles");
  wrap.innerHTML = POI_CATS.map((cat) => `
    <label class="uni-poi-toggle">
      <input type="checkbox" data-cat="${cat.key}" ${uniState.poiHidden.has(cat.key) ? "" : "checked"}>
      <span class="uni-poi-dot" style="background:${cat.color}"></span>
      ${cat.label} <span class="uni-poi-count">${counts.get(cat.key) ?? 0}</span>
    </label>`).join("");
  wrap.querySelectorAll("input[data-cat]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const lg = uniState.poiLayers.get(cb.dataset.cat);
      if (!lg) return;
      if (cb.checked) { uniState.poiHidden.delete(cb.dataset.cat); lg.addTo(uniState.map); }
      else { uniState.poiHidden.add(cb.dataset.cat); lg.remove(); }
    });
  });
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
  if (/^(university|college|dormitory)$/.test(tags.building || "") || amenity === "library") return "academic";
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
  for (const cat of POI_CATS) {
    capped.push(...pois.filter((p) => p.cat === cat.key)
      .sort((a, b) => dist(a) - dist(b))
      .slice(0, POI_CAP_PER_CAT));
  }

  try {
    localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), pois: capped }));
  } catch { /* quota exceeded - live without the cache */ }
  return capped;
}

