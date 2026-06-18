/* =============================================================
   Market State - new-supply cohort report (iframe tab)
   Reads market-state/_manifest.json, _cohort.json, and <key>.json
   built by load_market_state.py. Three levels: National / School /
   Property. Trends read across delivery vintages (2023-2026).
   ============================================================= */
"use strict";

const C = {
  slate: "#2b2825", slate70: "#5a544f", slate50: "#837c75", slate30: "#b6b1ab",
  everest: "#16352e", birch: "#a95818", lime: "#c1d100", warn: "#c79830",
  beige: "#f7f1e3", beigeDeep: "#ede5cf",
};
const VINTAGE_COLOR = { 2023: "#b6b1ab", 2024: "#c79830", 2025: "#a95818", 2026: "#16352e" };
const UNIT_ORDER = ["Studio", "1BR", "2BR", "3BR", "4BR", "5BR", "6BR+"];
const UNIT_COLOR = {
  "Studio": "#b6b1ab", "1BR": "#c79830", "2BR": "#a95818", "3BR": "#16352e",
  "4BR": "#c1d100", "5BR": "#512213", "6BR+": "#837c75",
};
const PARITY_ORDER = ["Parity", "Non-Parity", "Bath-Heavy", "Studio", "Unknown"];
const PARITY_COLOR = {
  "Parity": "#16352e", "Non-Parity": "#a95818", "Bath-Heavy": "#c79830",
  "Studio": "#b6b1ab", "Unknown": "#d8d4ce",
};

if (window.Chart) {
  Chart.defaults.font.family = "Pragmatica, -apple-system, 'Segoe UI', sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = C.slate70;
  if (window.ChartDataLabels) Chart.register(window.ChartDataLabels);
  Chart.defaults.plugins.datalabels = { display: false };
}

/* ----- formatters --------------------------------------------- */
const fInt = (v) => (v == null ? "-" : Math.round(v).toLocaleString("en-US"));
const fUsd = (v) => (v == null ? "-" : "$" + Math.round(v).toLocaleString("en-US"));
const fUsd2 = (v) => (v == null ? "-" : "$" + Number(v).toFixed(2));
const fPct = (v, d = 0) => (v == null ? "-" : (v * 100).toFixed(d) + "%");
const fPctSigned = (v, d = 1) => (v == null ? "-" : (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ----- state -------------------------------------------------- */
const state = {
  level: "national",
  cohort: "all",
  vintages: new Set(),          // empty = all
  schoolKey: null,
  buildingKey: null,
  propYear: null,               // selected year on the property page (null = latest)
  marketAnchor: "cycle",        // oct | june | cycle  (by-year market series anchor)
};
let MANIFEST = null;
let COHORT = null;
let AMEN = null;                // amenities/_rollup.json (competitor scrape)
const SCHOOL_CACHE = {};
let CHARTS = [];

const CAT_LABELS = {
  access_tech: "Access tech", outdoor: "Outdoor / rooftop", convenience: "Convenience",
  coffee_fnb: "Coffee & F&B", wellness: "Wellness / recovery", entertainment: "Entertainment",
  mobility: "Mobility / EV", pet: "Pet", novel: "Novel / other", smart_fitness: "Smart fitness",
  standard: "Standard",
};
const CAT_COLOR = {
  wellness: "#16352e", entertainment: "#a95818", access_tech: "#c79830", coffee_fnb: "#512213",
  convenience: "#5a544f", mobility: "#7a8a00", pet: "#b6843f", outdoor: "#2f6f6f",
  smart_fitness: "#8a4f86", novel: "#9aa0a6",
};

/* ----- raw-component aggregation (mirror of the Python) -------- */
function finish(m) {
  const rb = m._rd ? m._rn / m._rd : null;
  const rs = m._sfd ? m._sfn / m._sfd : null;
  const oc = m._od ? m._on / m._od : null;
  const av = m._pd ? m._pn / m._pd : null;
  return Object.assign(m, {
    rate_bed: rb, rate_sf: rs, occ: oc,
    prelease: av == null ? null : 1 - av,
    sf_per_bed: rb && rs ? rb / rs : null,
  });
}
function aggNodes(nodes) {
  nodes = (nodes || []).filter(Boolean);
  if (!nodes.length) return null;
  const t = { beds: 0, units: 0, _rn: 0, _rd: 0, _sfn: 0, _sfd: 0, _on: 0, _od: 0, _pn: 0, _pd: 0 };
  nodes.forEach((n) => { for (const k in t) t[k] += (n[k] || 0); });
  return finish(t);
}
function nonParityShare(parityNodes) {
  const np = (parityNodes || []).find((p) => p.cat === "Non-Parity");
  const tot = (parityNodes || []).reduce((s, p) => s + (p.beds || 0), 0);
  return tot ? (np ? np.beds : 0) / tot : null;
}
function yoyLatest(series, field) {
  // series: [{year|cycle, rate_bed,...}] sorted asc. Returns latest YoY.
  const s = (series || []).filter((r) => r[field] != null);
  if (s.length < 2) return null;
  const a = s[s.length - 2][field], b = s[s.length - 1][field];
  return a ? b / a - 1 : null;
}

/* ----- chart helpers ------------------------------------------ */
function newChart(canvas, cfg) {
  const ch = new Chart(canvas.getContext("2d"), cfg);
  CHARTS.push(ch);
  return ch;
}
function clearCharts() { CHARTS.forEach((c) => c.destroy()); CHARTS = []; }

function barChartH(canvas, labels, data, colors, fmt) {
  if (!canvas) return;
  newChart(canvas, {
    type: "bar",
    data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => fmt(c.raw) } },
        datalabels: { display: true, anchor: "end", align: "end", color: C.slate70, font: { weight: "700", size: 10 }, formatter: (v) => fmt(v) },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { display: false } },
        y: { grid: { display: false }, border: { display: false }, ticks: { font: { weight: "600", size: 10 } } },
      },
      layout: { padding: { right: 40 } },
    },
  });
}

/* ----- competitor amenities & fees (from amenities/_rollup.json) ----- */
function amenitiesNationalHtml() {
  if (!AMEN) return "";
  const f = AMEN.fees, bb = AMEN.billbacks;
  const billers = Object.entries(bb.billers || {}).map(([k, v]) => `${esc(k)} (${v})`).join(", ");
  return `<div class="ms-card">
    <h2>Competitor Amenities &amp; Fees</h2>
    <p class="sub">Scraped from ${AMEN.n_scraped} cohort buildings' own official sites. "Emerging" = beyond table-stakes (pool, gym, study rooms, clubhouse).</p>
    <div class="ms-kpis">
      <div class="ms-kpi"><div class="l">Buildings scraped</div><div class="v">${AMEN.n_scraped}</div><div class="s">of ${AMEN.n_targets}</div></div>
      <div class="ms-kpi"><div class="l">Avg emerging amenities</div><div class="v">${AMEN.avg_emerging_per_building}</div><div class="s">per building</div></div>
      <div class="ms-kpi"><div class="l">Application fee</div><div class="v">${f.application.median != null ? fUsd(f.application.median) : "-"}</div><div class="s">median (n=${f.application.n})</div></div>
      <div class="ms-kpi"><div class="l">Admin fee</div><div class="v">${f.admin.median != null ? fUsd(f.admin.median) : "-"}</div><div class="s">median (n=${f.admin.n})</div></div>
      <div class="ms-kpi"><div class="l">Charge for parking</div><div class="v">${f.parking_pct}%</div><div class="s">of buildings</div></div>
      <div class="ms-kpi"><div class="l">Utility RUBS</div><div class="v">${bb.rubs_pct}%</div><div class="s">pass-through</div></div>
    </div>
    <div class="ms-grid">
      <div class="ms-chart"><h3>Emerging Amenity Prevalence by Category (# of buildings)</h3><div class="ms-chart-wrap tall"><canvas id="amen-cat"></canvas></div></div>
      <div class="ms-chart"><h3>Most Common Emerging Amenities</h3><div class="ms-chart-wrap tall"><canvas id="amen-top"></canvas></div></div>
    </div>
    <div class="ms-chart"><h3>Emerging Category Adoption by Delivery Vintage (% of buildings)</h3><div class="ms-chart-wrap tall"><canvas id="amen-vintage"></canvas></div></div>
    <p class="ms-note">Utility billers seen: ${billers || "n/a"}. Trash included in rent at ${bb.trash_included_pct}% of buildings.</p>
  </div>`;
}
function drawAmenitiesNational() {
  if (!AMEN) return;
  const cats = Object.entries(AMEN.category_prevalence || {}).filter(([c]) => c !== "standard");
  barChartH(document.getElementById("amen-cat"), cats.map(([c]) => CAT_LABELS[c] || c),
    cats.map(([, n]) => n), cats.map(() => C.everest), (v) => v + " bldgs");
  const top = (AMEN.top_emerging || []).slice(0, 15);
  barChartH(document.getElementById("amen-top"), top.map((t) => t.name),
    top.map((t) => t.count), top.map(() => C.birch), (v) => v + " bldgs");

  // emerging category adoption by delivery vintage (prevalence % of that vintage's buildings)
  const nbv = AMEN.n_by_vintage || {}, bvc = AMEN.by_vintage_category || {};
  const years = Object.keys(nbv).sort();
  if (years.length) {
    const cats = Object.keys(AMEN.category_prevalence || {}).filter((c) => c !== "standard");
    const datasets = cats.map((c) => ({
      label: CAT_LABELS[c] || c, borderColor: CAT_COLOR[c] || C.slate70,
      data: years.map((v) => (nbv[v] ? ((bvc[v] || {})[c] || 0) / nbv[v] : null)),
    }));
    lineChart(document.getElementById("amen-vintage"), years, datasets, (v) => fPct(v, 0));
  }
}
function amenitiesSchoolHtml(mk) {
  const m = AMEN && AMEN.per_market && AMEN.per_market[String(mk)];
  if (!m) return "";
  const rows = m.buildings.map((b) => {
    const em = (b.emerging || []).map((e) => esc(e.name)).join(", ") || "-";
    const f = b.fees || {};
    const site = b.official_url ? `<a href="${esc(b.official_url)}" target="_blank" rel="noopener">site</a>` : "-";
    const cell = (v) => (v == null || v === "" ? "-" : esc(String(v)));
    const biller = (b.billbacks && b.billbacks.utilities_biller) ? esc(b.billbacks.utilities_biller) : "-";
    return `<tr><td>${esc(b.name)}</td><td>${b.vintage || ""}</td><td>${site}</td><td style="text-align:left;white-space:normal">${em}</td><td>${cell(f.application)}</td><td>${cell(f.admin)}</td><td>${cell(f.parking)}</td><td>${biller}</td></tr>`;
  }).join("");
  return `<div class="ms-card">
    <h2>Competitor Amenities &amp; Fees</h2>
    <p class="sub">From each building's official website. Emerging amenities, published fees, and utility biller.</p>
    <div class="ms-table-wrap"><table class="ms-table">
      <thead><tr><th>Building</th><th>Vintage</th><th>Site</th><th>Emerging amenities</th><th>App</th><th>Admin</th><th>Parking</th><th>Biller</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
  </div>`;
}

const cleanScale = (fmt) => ({
  grid: { display: false }, border: { display: false },
  ticks: { callback: fmt, font: { weight: "600" } },
});

function barChart(canvas, labels, data, colors, fmt, dlFmt) {
  newChart(canvas, {
    type: "bar",
    data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 4, maxBarThickness: 64 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => fmt(c.raw) } },
        datalabels: dlFmt ? { display: true, anchor: "end", align: "end", color: C.slate70,
          font: { weight: "700", size: 10 }, formatter: dlFmt } : { display: false },
      },
      scales: { x: { grid: { display: false }, border: { display: false } }, y: cleanScale(fmt) },
      layout: { padding: { top: 18 } },
    },
  });
}

function groupedBar(canvas, labels, datasets, fmt) {
  newChart(canvas, {
    type: "bar",
    data: { labels, datasets: datasets.map((d) => ({ ...d, borderRadius: 3, maxBarThickness: 34 })) },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: true, position: "bottom", labels: { boxWidth: 12, usePointStyle: true, font: { size: 10 } } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw)}` } },
        datalabels: { display: false },
      },
      scales: { x: { grid: { display: false }, border: { display: false } }, y: cleanScale(fmt) },
    },
  });
}

function stackedPct(canvas, labels, series) {
  newChart(canvas, {
    type: "bar",
    data: { labels, datasets: series.map((s) => ({ label: s.label, data: s.data, backgroundColor: s.color, maxBarThickness: 70 })) },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: true, position: "bottom", labels: { boxWidth: 12, usePointStyle: true, font: { size: 10 } } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${(c.raw * 100).toFixed(0)}%` } },
        datalabels: { display: false },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, border: { display: false } },
        y: { stacked: true, max: 1, grid: { display: false }, border: { display: false },
             ticks: { callback: (v) => v * 100 + "%", font: { weight: "600" } } },
      },
    },
  });
}

function lineChart(canvas, labels, datasets, fmt) {
  newChart(canvas, {
    type: "line",
    data: { labels, datasets: datasets.map((d) => ({ ...d, borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: true })) },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: datasets.length > 1, position: "bottom", labels: { boxWidth: 12, usePointStyle: true, font: { size: 10 } } },
        tooltip: { mode: "index", intersect: false, callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw)}` } },
        datalabels: { display: false },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { maxTicksLimit: 10, font: { size: 9 } } },
        y: cleanScale(fmt),
      },
    },
  });
}

/* ----- shared builders ---------------------------------------- */
function kpiBand(m, extra) {
  const cells = [];
  (extra || []).forEach((e) => cells.push(`<div class="ms-kpi"><div class="l">${e.l}</div><div class="v">${e.v}</div><div class="s">${e.s || ""}</div></div>`));
  if (m) {
    cells.push(
      `<div class="ms-kpi"><div class="l">Avg Rent / Bed</div><div class="v">${fUsd(m.rate_bed)}</div><div class="s">bed-weighted</div></div>`,
      `<div class="ms-kpi"><div class="l">Rent / SF</div><div class="v">${fUsd2(m.rate_sf)}</div><div class="s">${m.sf_per_bed ? fInt(m.sf_per_bed) + " sf/bed" : ""}</div></div>`,
      `<div class="ms-kpi"><div class="l">Occupancy</div><div class="v">${fPct(m.occ)}</div><div class="s">in place</div></div>`,
      `<div class="ms-kpi"><div class="l">Prelease</div><div class="v">${fPct(m.prelease)}</div><div class="s">upcoming term</div></div>`,
    );
  }
  return `<div class="ms-kpis">${cells.join("")}</div>`;
}

/* Market performance, tracked by calendar period across the cohort.
   Anchor 'oct'/'june' key on year; 'cycle' keys on cycle. */
const ANCHOR_SERIES = { oct: "market_oct", june: "market_june", cycle: "market_cycles" };
const ANCHOR_SERIES_SCHOOL = { oct: "school_oct", june: "school_june", cycle: "school_cycles" };
const anchorKey = () => (state.marketAnchor === "cycle" ? "cycle" : "year");
// Drop truncated leasing cycles (their Sep-Dec start is outside our data window).
const anchorClean = (series) =>
  (series || []).filter((r) => !(state.marketAnchor === "cycle" && r.truncated));

function marketCum(series, key) {
  key = key || "year";
  const s = (series || []).filter((r) => r.rate_bed != null).sort((a, b) => a[key] - b[key]);
  if (s.length < 2) return null;
  return { cum: s[s.length - 1].rate_bed / s[0].rate_bed - 1, from: s[0][key], to: s[s.length - 1][key] };
}

function anchorToggleHtml() {
  const opts = [["oct", "October"], ["june", "June"], ["cycle", "Leasing Cycle"]];
  return `<div class="ms-cohort ms-anchor" id="ms-anchor">` +
    opts.map(([v, l]) => `<button data-anchor="${v}" class="${state.marketAnchor === v ? "active" : ""}">${l}</button>`).join("") + `</div>`;
}
function bindAnchor() {
  document.querySelectorAll("#ms-anchor button").forEach((b) =>
    b.addEventListener("click", () => { state.marketAnchor = b.dataset.anchor; render(); }));
}

function marketYearScaffold(id) {
  return `<div class="ms-grid">
    <div class="ms-chart"><h3>Market Rent / Bed by Year</h3><div class="ms-chart-wrap"><canvas id="${id}-myrent"></canvas></div></div>
    <div class="ms-chart"><h3>Market Occupancy by Year</h3><div class="ms-chart-wrap"><canvas id="${id}-myocc"></canvas></div></div>
    <div class="ms-chart"><h3>Market Prelease by Year</h3><div class="ms-chart-wrap"><canvas id="${id}-mypre"></canvas></div></div>
    <div class="ms-chart"><h3>Rent Growth by Year (YoY)</h3><div class="ms-chart-wrap"><canvas id="${id}-myyoy"></canvas></div></div>
  </div>`;
}

function drawMarketYear(id, series, key, bench) {
  key = key || "year";
  const s = (series || []).filter((r) => r[key] != null).slice().sort((a, b) => a[key] - b[key]);
  if (!s.length) return;
  const labels = s.map((r) => r[key]);
  const bm = {};
  (bench || []).forEach((b) => { bm[b.year] = b; });
  const hasBench = (bench || []).length > 0;
  const benchAt = (lbl, f) => (bm[lbl] ? bm[lbl][f] : null);

  // New supply (cohort) vs whole market (benchmark), grouped when bench exists.
  const metricChart = (canvasId, field, fmt, soloColor) => {
    const el = document.getElementById(canvasId);
    if (!el) return;
    if (hasBench) {
      groupedBar(el, labels, [
        { label: "New supply", data: s.map((r) => r[field]), backgroundColor: C.everest },
        { label: "Whole market", data: labels.map((l) => benchAt(l, field)), backgroundColor: C.slate30 },
      ], fmt);
    } else {
      barChart(el, labels, s.map((r) => r[field]), labels.map(() => soloColor), fmt, fmt);
    }
  };
  metricChart(id + "-myrent", "rate_bed", (v) => fUsd(v), C.everest);
  metricChart(id + "-myocc", "occ", (v) => fPct(v, 0), C.birch);
  metricChart(id + "-mypre", "prelease", (v) => fPct(v, 0), C.warn);

  // Rent YoY: cohort vs whole-market YoY (or cohort-only solo).
  const cohortYoy = s.map((r, i) => (i > 0 && s[i - 1].rate_bed ? r.rate_bed / s[i - 1].rate_bed - 1 : null));
  const yoyEl = document.getElementById(id + "-myyoy");
  if (hasBench) {
    const benchYoy = labels.map((l) => {
      const cur = bm[l], prev = bm[l - 1];
      return cur && prev && prev.rate_bed ? cur.rate_bed / prev.rate_bed - 1 : null;
    });
    groupedBar(yoyEl, labels, [
      { label: "New supply", data: cohortYoy, backgroundColor: C.everest },
      { label: "Whole market", data: benchYoy, backgroundColor: C.slate30 },
    ], (v) => fPctSigned(v));
  } else {
    barChart(yoyEl, labels, cohortYoy,
      cohortYoy.map((v) => (v == null ? C.slate30 : v >= 0 ? C.everest : C.birch)), (v) => fPctSigned(v), (v) => fPctSigned(v));
  }
}

/* Composition, kept by delivery vintage (full cohort, incl. not-yet-open). */
function compVintageScaffold(id) {
  return `<div class="ms-grid">
    <div class="ms-chart"><h3>Avg Floor-Plan Size (SF/Bed) by Vintage</h3><div class="ms-chart-wrap"><canvas id="${id}-sf"></canvas></div></div>
    <div class="ms-chart"><h3>Unit-Type Mix by Vintage (share of beds)</h3><div class="ms-chart-wrap tall"><canvas id="${id}-mix"></canvas></div></div>
    <div class="ms-chart"><h3>Parity Mix by Vintage (share of beds)</h3><div class="ms-chart-wrap tall"><canvas id="${id}-parity"></canvas></div></div>
  </div>`;
}

function drawCompVintage(id, vintnodes) {
  const labels = vintnodes.map((v) => v.vintage);
  const colors = labels.map((y) => VINTAGE_COLOR[y] || C.slate70);
  barChart(document.getElementById(id + "-sf"), labels,
    vintnodes.map((v) => v.latest.sf_per_bed), colors, (v) => fInt(v) + " sf", (v) => fInt(v));
  stackedPct(document.getElementById(id + "-mix"), labels,
    UNIT_ORDER.map((t) => ({
      label: t, color: UNIT_COLOR[t],
      data: vintnodes.map((v) => {
        const tot = v.unit_types.reduce((s, u) => s + (u.beds || 0), 0);
        const node = v.unit_types.find((u) => u.cat === t);
        return tot ? (node ? node.beds : 0) / tot : 0;
      }),
    })));
  const parityCats = PARITY_ORDER.filter((cat) => vintnodes.some((v) => v.parity.some((p) => p.cat === cat)));
  stackedPct(document.getElementById(id + "-parity"), labels,
    parityCats.map((cat) => ({
      label: cat, color: PARITY_COLOR[cat],
      data: vintnodes.map((v) => {
        const tot = v.parity.reduce((s, p) => s + (p.beds || 0), 0);
        const node = v.parity.find((p) => p.cat === cat);
        return tot ? (node ? node.beds : 0) / tot : 0;
      }),
    })));
}

function breakdownTable(rows, label) {
  const head = `<thead><tr><th>${label}</th><th>Beds</th><th>Units</th><th>Rent/Bed</th><th>Rent/SF</th><th>SF/Bed</th><th>Occ</th><th>Prelease</th></tr></thead>`;
  const body = rows.map((r) => `<tr><td>${esc(r.cat)}</td><td>${fInt(r.beds)}</td><td>${fInt(r.units)}</td><td>${fUsd(r.rate_bed)}</td><td>${fUsd2(r.rate_sf)}</td><td>${fInt(r.sf_per_bed)}</td><td>${fPct(r.occ)}</td><td>${fPct(r.prelease)}</td></tr>`).join("");
  return `<div class="ms-table-wrap"><table class="ms-table">${head}<tbody>${body}</tbody></table></div>`;
}

/* ----- vintage filter ----------------------------------------- */
function filterVintages(nodes) {
  if (!state.vintages.size) return nodes;
  return nodes.filter((v) => state.vintages.has(v.vintage));
}

/* ----- NATIONAL ----------------------------------------------- */
function renderNational() {
  const c = COHORT.cohorts[state.cohort];
  if (!c || !c.by_vintage.length) { content("<div class='ms-empty'>No data for this cohort yet.</div>"); return; }
  const vints = filterVintages(c.by_vintage);
  const market = anchorClean(c[ANCHOR_SERIES[state.marketAnchor]]);
  const pkey = anchorKey();
  const june = c.market_june || [];
  const mLatest = june.length ? june.slice().sort((a, b) => a.year - b.year)[june.length - 1] : null;
  const natLayouts = aggNodesBreakdown(vints, "layouts");
  const nb = vints.reduce((s, v) => s + v.buildings, 0);
  const cum = marketCum(market, pkey);

  const cohortMarkets = COHORT.markets.filter((m) =>
    state.cohort === "all" || (state.cohort === "s30" && m.is_subtext30) || (state.cohort === "pursuit" && m.is_pursuit));

  const html = `
    ${kpiBand(mLatest, [
      { l: "Schools", v: fInt(c.n_schools), s: "in cohort" },
      { l: "New Buildings", v: fInt(nb), s: "delivered 2023-26" },
      { l: "Open Beds", v: fInt(mLatest ? mLatest.beds : 0), s: "latest (June)" },
    ])}
    <div class="ms-reportbar">
      <a class="ms-reportbtn" href="market-state-report.html?level=national" target="_blank" rel="noopener">Open Data Report (PDF) &rarr;</a>
      <a class="ms-reportbtn ms-reportbtn-alt" href="reports/MarketState_National.docx" download="MarketState_National.docx">Download Narrative Report (Word) &darr;</a>
    </div>
    <div class="ms-card">
      <h2>New Supply vs Whole Market by Year</h2>
      <p class="sub">New-supply cohort (rent from stabilized, occ/prelease from operating) vs the whole market for these schools (dashboard data). October carries 2023; June reaches 2026.${cum ? ` New-supply cumulative rent ${fPctSigned(cum.cum)} (${cum.from} to ${cum.to}).` : ""}</p>
      ${anchorToggleHtml()}
      ${marketYearScaffold("nat")}
    </div>
    <div class="ms-card">
      <h2>Composition by Vintage</h2>
      <p class="sub">What new product looks like by the year it delivered. The vintage chips and cohort toggle above filter this.</p>
      ${compVintageScaffold("nat")}
    </div>
    ${layoutCard("nat", natLayouts)}
    ${amenitiesNationalHtml()}
    <div class="ms-card">
      <h2>New Supply by Market</h2>
      <p class="sub">Click a market to open its school-level report.</p>
      ${marketsTable(cohortMarkets)}
    </div>`;
  content(html);
  drawMarketYear("nat", market, pkey, c.market_overall);
  drawCompVintage("nat", vints);
  drawLayoutChart("nat", natLayouts);
  drawAmenitiesNational();
  bindAnchor();
  bindMarketRows();
}

function aggNodesBreakdown(vintnodes, kind) {
  // merge a breakdown ([{cat, ...metrics}]) across vintages, re-aggregating
  // raw components so the result carries full metrics (rate_bed etc.).
  const map = {};
  vintnodes.forEach((v) => (v[kind] || []).forEach((p) => {
    (map[p.cat] = map[p.cat] || []).push(p);
  }));
  return Object.entries(map).map(([cat, nodes]) => ({ cat, ...aggNodes(nodes) }));
}

/* ----- layout (BRxBA) helpers --------------------------------- */
function layoutSortKey(cat) {
  if (cat === "Studio") return [0, 0];
  const p = String(cat).split("x");
  return [parseInt(p[0], 10) || 99, p[1] === "?" ? 99 : (parseFloat(p[1]) || 99)];
}
function cmpLayout(a, b) {
  const ka = layoutSortKey(a), kb = layoutSortKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1];
}
function layoutParity(cat) {
  if (cat === "Studio") return "Parity";   // studio = private bath = parity
  const p = String(cat).split("x");
  const br = parseInt(p[0], 10), ba = parseFloat(p[1]);
  if (isNaN(ba)) return "Unknown";
  if (ba === br) return "Parity";
  if (ba < br) return "Non-Parity";
  return "Bath-Heavy";
}
function layoutCard(pfx, layouts) {
  const tall = (layouts || []).length > 8 ? " tall" : "";
  return `<div class="ms-card">
    <h2>Unit Type x Parity (Layout)</h2>
    <p class="sub">Bedroom count split by bathroom count: 4x4 (private bath) vs 4x2 (shared), etc. Bars colored by parity (everest = parity, birch = non-parity).</p>
    <div class="ms-grid"><div class="ms-chart"><h3>Avg Rent / Bed by Layout</h3><div class="ms-chart-wrap${tall}"><canvas id="${pfx}-layout"></canvas></div></div></div>
    ${breakdownTable((layouts || []).slice().sort((a, b) => cmpLayout(a.cat, b.cat)), "Layout")}
  </div>`;
}
function drawLayoutChart(pfx, layouts) {
  const el = document.getElementById(pfx + "-layout");
  if (!el || !layouts || !layouts.length) return;
  const sorted = layouts.slice().sort((a, b) => cmpLayout(a.cat, b.cat));
  barChart(el, sorted.map((l) => l.cat), sorted.map((l) => l.rate_bed),
    sorted.map((l) => PARITY_COLOR[layoutParity(l.cat)] || C.slate30), fUsd, (v) => fUsd(v));
}

function marketsTable(markets) {
  const head = `<thead><tr><th>Market</th><th>Bldgs</th><th>Beds</th><th>Rent/Bed</th><th>Rent/SF</th><th>Occ</th><th>Prelease</th><th>Vintages</th></tr></thead>`;
  const body = markets.map((m) => {
    const L = m.latest || {};
    const tags = (m.is_subtext30 ? '<span class="ms-tag s30">S30</span>' : "") + (m.is_pursuit ? '<span class="ms-tag pursuit">Pursuit</span>' : "");
    return `<tr class="clickable" data-mk="${m.market_key}"><td>${esc(m.market_name)}${tags}</td><td>${fInt(m.n_buildings)}</td><td>${fInt(L.beds)}</td><td>${fUsd(L.rate_bed)}</td><td>${fUsd2(L.rate_sf)}</td><td>${fPct(L.occ)}</td><td>${fPct(L.prelease)}</td><td>${(m.vintages || []).join(", ")}</td></tr>`;
  }).join("");
  return `<div class="ms-table-wrap"><table class="ms-table">${head}<tbody>${body}</tbody></table></div>`;
}

function bindMarketRows() {
  document.querySelectorAll("tr.clickable[data-mk]").forEach((tr) => {
    tr.addEventListener("click", () => {
      state.schoolKey = Number(tr.dataset.mk);
      setLevel("school");
    });
  });
}

/* ----- lease-up / no-operating-history fallbacks -------------- */
// Markets whose buildings are all still in lease-up have no operating-derived
// data (school_monthly / school_oct|june|cycles / school snapshots are built
// from operating building-months, occ>0). The by-vintage composition still
// carries asking-rent data, so we aggregate that as a fallback and explain why
// the time-series sections are blank.
const ANCHOR_LABEL = { oct: "October", june: "June", cycle: "Leasing Cycle" };
const COMP_KEYS = ["beds", "units", "_rn", "_rd", "_sfn", "_sfd", "_on", "_od", "_pn", "_pd"];

function finishNode(c) {
  const rb = c._rd ? c._rn / c._rd : null;
  const rs = c._sfd ? c._sfn / c._sfd : null;
  return Object.assign({}, c, {
    rate_bed: rb, rate_sf: rs,
    sf_per_bed: (rb != null && rs) ? rb / rs : null,
    occ: c._od ? c._on / c._od : null,
    prelease: c._pd ? 1 - c._pn / c._pd : null,
  });
}
function aggLatest(vints) {
  if (!vints || !vints.length) return null;
  const c = {}; COMP_KEYS.forEach((k) => (c[k] = 0));
  vints.forEach((v) => { const L = v.latest || {}; COMP_KEYS.forEach((k) => (c[k] += L[k] || 0)); });
  return finishNode(c);
}
function aggBreakdown(vints, field) {
  const m = {};
  (vints || []).forEach((v) => (v[field] || []).forEach((n) => {
    const d = m[n.cat] || (m[n.cat] = Object.assign({ cat: n.cat }, Object.fromEntries(COMP_KEYS.map((k) => [k, 0]))));
    COMP_KEYS.forEach((k) => (d[k] += n[k] || 0));
  }));
  return Object.values(m).map(finishNode);
}
function noteInline(html) { return `<div class="ms-empty">${html}</div>`; }

function leaseUpBanner(s) {
  const vs = [...new Set(s.buildings.map((b) => b.vintage))].sort();
  const vtxt = vs.length === 1 ? `were all delivered in ${vs[0]}` : `were delivered ${vs[0]}–${vs[vs.length - 1]}`;
  return `<div class="ms-banner"><b>Why some sections are blank:</b> this market's ${s.n_buildings} new ${s.n_buildings === 1 ? "building" : "buildings"} ${vtxt} and ${s.n_buildings === 1 ? "is" : "are"} not yet stabilized (still in lease-up), so there is no operating or prior-year history to chart. Views that need a same-store time series (rent growth by year, occupancy and prelease trend) stay blank until the buildings report occupancy. Current asking rent, prelease, unit mix and parity are shown below from the latest listings. This is expected for brand-new supply, not missing data.</div>`;
}
function perfEmptyNote(s) {
  const octN = (s.school_oct || []).length, juneN = (s.school_june || []).length,
        cycN = (s.school_cycles || []).filter((r) => !r.truncated).length;
  const others = [];
  if (state.marketAnchor !== "oct" && octN) others.push("October");
  if (state.marketAnchor !== "june" && juneN) others.push("June");
  if (state.marketAnchor !== "cycle" && cycN) others.push("Leasing Cycle");
  if (others.length) {
    const why = state.marketAnchor === "cycle"
      ? "The Leasing Cycle anchor only counts completed cycles inside the data window, and this market has none yet."
      : "No buildings here have a reading on this anchor month yet.";
    return noteInline(`No year-by-year data on the <b>${ANCHOR_LABEL[state.marketAnchor]}</b> anchor. ${why} Switch to the ${others.join(" or ")} anchor above to see it.`);
  }
  return noteInline("No year-by-year performance yet — these buildings have no stabilized or prior-year history (see the note above).");
}

/* ----- SCHOOL ------------------------------------------------- */
async function renderSchool() {
  if (!state.schoolKey) state.schoolKey = MANIFEST.schools[0] && MANIFEST.schools[0].market_key;
  const s = await loadSchool(state.schoolKey);
  if (!s) { content("<div class='ms-empty'>School not built yet.</div>"); return; }
  const vints = filterVintages(s.by_vintage);
  const market = anchorClean(s[ANCHOR_SERIES_SCHOOL[state.marketAnchor]]);
  const pkey = anchorKey();
  const june = s.school_june || [];
  const monthly = s.school_monthly || [];
  const cum = marketCum(market, pkey);

  // Fall back to the by-vintage snapshot when operating-derived sections are empty (lease-up markets).
  const noOperating = !monthly.length;
  const mLatest = (june.length ? june.slice().sort((a, b) => a.year - b.year)[june.length - 1] : null) || aggLatest(vints);
  const uts = s.school_unit_types.length ? s.school_unit_types : aggBreakdown(vints, "unit_types");
  const par = s.school_parity.length ? s.school_parity : aggBreakdown(vints, "parity");
  const lays = s.school_layouts.length ? s.school_layouts : aggBreakdown(vints, "layouts");
  const perfHasData = market.some((r) => r[pkey] != null);
  const latestLbl = june.length ? "latest (June)" : "current listings";

  const monthsLbl = monthly.map((r) => r.month.slice(0, 7));
  const html = `
    ${noOperating ? leaseUpBanner(s) : ""}
    ${kpiBand(mLatest, [
      { l: "Buildings", v: fInt(s.n_buildings), s: "in cohort" },
      { l: "Open Beds", v: fInt(mLatest ? mLatest.beds : 0), s: latestLbl },
    ])}
    <div class="ms-reportbar"><a class="ms-reportbtn" href="market-state-report.html?market=${s.market_key}" target="_blank" rel="noopener">Open Data Report (PDF) &rarr;</a></div>
    <div class="ms-card">
      <h2>${esc(s.market_name)} - New Supply vs Whole Market</h2>
      <p class="sub">This school's new-supply cohort vs its whole market (dashboard data), by year. Benchmarking against the full market gives the small new-supply sample context.${cum ? ` New-supply cumulative rent ${fPctSigned(cum.cum)} (${cum.from} to ${cum.to}).` : ""}</p>
      ${anchorToggleHtml()}
      ${perfHasData ? marketYearScaffold("sch") : perfEmptyNote(s)}
    </div>
    <div class="ms-card">
      <h2>Composition by Vintage</h2>
      <p class="sub">What new buildings at this school look like, by delivery year.</p>
      ${compVintageScaffold("sch")}
    </div>
    <div class="ms-card">
      <h2>Cohort Trend Over Time</h2>
      <p class="sub">Monthly bed-weighted aggregate across this school's open cohort. Occupancy dips each August are the lease-turn, not a real drop.</p>
      ${monthly.length ? `<div class="ms-grid">
        <div class="ms-chart"><h3>Rent / Bed</h3><div class="ms-chart-wrap"><canvas id="sch-trend-rent"></canvas></div></div>
        <div class="ms-chart"><h3>Occupancy</h3><div class="ms-chart-wrap"><canvas id="sch-trend-occ"></canvas></div></div>
        <div class="ms-chart"><h3>Prelease (upcoming term)</h3><div class="ms-chart-wrap"><canvas id="sch-trend-pre"></canvas></div></div>
      </div>` : noteInline("No monthly operating history yet — this populates once the buildings open and report occupancy.")}
    </div>
    <div class="ms-card"><h2>Unit Type Detail (${noOperating ? "asking, latest listings" : "latest"})</h2>${breakdownTable(uts, "Unit Type")}</div>
    <div class="ms-card"><h2>Parity Detail (${noOperating ? "asking, latest listings" : "latest"})</h2>${breakdownTable(par, "Class")}</div>
    ${layoutCard("sch", lays)}
    <div class="ms-card"><h2>Buildings</h2><p class="sub">Click a building for its detail.</p>${buildingsTable(s.buildings)}</div>
    ${amenitiesSchoolHtml(state.schoolKey)}`;
  content(html);
  if (perfHasData) drawMarketYear("sch", market, pkey, s.market_overall);
  drawCompVintage("sch", vints);
  drawLayoutChart("sch", lays);
  bindAnchor();
  if (monthly.length) {
    lineChart(document.getElementById("sch-trend-rent"), monthsLbl, [{ label: "Rent/Bed", data: monthly.map((r) => r.rate_bed), borderColor: C.everest }], fUsd);
    lineChart(document.getElementById("sch-trend-occ"), monthsLbl, [{ label: "Occupancy", data: monthly.map((r) => r.occ), borderColor: C.birch }], (v) => fPct(v, 0));
    lineChart(document.getElementById("sch-trend-pre"), monthsLbl, [{ label: "Prelease", data: monthly.map((r) => r.prelease), borderColor: C.lime }], (v) => fPct(v, 0));
  }
  bindBuildingRows();
}

function buildingsTable(buildings) {
  const head = `<thead><tr><th>Building</th><th>Vintage</th><th>Beds</th><th>Units</th><th>Rent/Bed</th><th>Rent/SF</th><th>SF/Bed</th><th>Occ</th><th>Prelease</th><th>Non-Parity</th><th>Mi</th></tr></thead>`;
  const body = buildings.map((b) => {
    const L = b.latest;
    return `<tr class="clickable" data-bk="${b.property_key}"><td>${esc(b.name)}</td><td>${b.vintage}</td><td>${fInt(L.beds)}</td><td>${fInt(L.units)}</td><td>${fUsd(L.rate_bed)}</td><td>${fUsd2(L.rate_sf)}</td><td>${fInt(L.sf_per_bed)}</td><td>${fPct(L.occ)}</td><td>${fPct(L.prelease)}</td><td>${fPct(nonParityShare(b.parity))}</td><td>${b.miles_to_campus != null ? b.miles_to_campus.toFixed(1) : "-"}</td></tr>`;
  }).join("");
  return `<div class="ms-table-wrap"><table class="ms-table">${head}<tbody>${body}</tbody></table></div>`;
}

function bindBuildingRows() {
  document.querySelectorAll("tr.clickable[data-bk]").forEach((tr) => {
    tr.addEventListener("click", () => {
      state.buildingKey = Number(tr.dataset.bk);
      state.propYear = null;
      setLevel("property");
    });
  });
}

/* ----- PROPERTY ----------------------------------------------- */
function yearByTable(rows) {
  const head = `<thead><tr><th>Year</th><th>Beds</th><th>Rent/Bed</th><th>Rent/SF</th><th>SF/Bed</th><th>Occ</th><th>Prelease</th></tr></thead>`;
  const body = (rows || []).map((r) =>
    `<tr><td>${r.year}</td><td>${fInt(r.beds)}</td><td>${fUsd(r.rate_bed)}</td><td>${fUsd2(r.rate_sf)}</td><td>${fInt(r.sf_per_bed)}</td><td>${fPct(r.occ)}</td><td>${fPct(r.prelease)}</td></tr>`).join("");
  return `<div class="ms-table-wrap"><table class="ms-table">${head}<tbody>${body}</tbody></table></div>`;
}

const fPP = (d) => (d == null || isNaN(d) ? "-" : (d >= 0 ? "+" : "") + (d * 100).toFixed(1) + " pp");
const pctChg = (a, z) => (a && z ? z / a - 1 : null);
const ppChg = (a, z) => (a != null && z != null ? z - a : null);

function cumKpiBand(base, last, b, s) {
  const cells = [
    { l: "Building", v: esc(b.name), s: `${esc(s.market_name)} · delivered ${b.vintage}` },
    { l: "Rent / Bed", v: fPctSigned(pctChg(base.rate_bed, last.rate_bed)), s: `${base.year} ${fUsd(base.rate_bed)} → ${last.year} ${fUsd(last.rate_bed)}` },
    { l: "Rent / SF", v: fPctSigned(pctChg(base.rate_sf, last.rate_sf)), s: `${fUsd2(base.rate_sf)} → ${fUsd2(last.rate_sf)}` },
    { l: "Avg SF / Bed", v: fPctSigned(pctChg(base.sf_per_bed, last.sf_per_bed)), s: `${fInt(base.sf_per_bed)} → ${fInt(last.sf_per_bed)} sf` },
    { l: "Occupancy", v: fPP(ppChg(base.occ, last.occ)), s: `${fPct(base.occ)} → ${fPct(last.occ)}` },
    { l: "Prelease", v: fPP(ppChg(base.prelease, last.prelease)), s: `${fPct(base.prelease)} → ${fPct(last.prelease)}` },
  ];
  return `<div class="ms-kpis">` + cells.map((c) => `<div class="ms-kpi"><div class="l">${c.l}</div><div class="v">${c.v}</div><div class="s">${c.s || ""}</div></div>`).join("") + `</div>`;
}

function cumLayoutGrowth(baseLayouts, lastLayouts) {
  const bm = Object.fromEntries((baseLayouts || []).map((x) => [x.cat, x]));
  return (lastLayouts || []).map((l) => {
    const bb = bm[l.cat];
    return { cat: l.cat, base: bb ? bb.rate_bed : null, last: l.rate_bed, cum: pctChg(bb && bb.rate_bed, l.rate_bed), beds: l.beds };
  }).sort((a, b) => cmpLayout(a.cat, b.cat));
}

async function renderProperty() {
  const s = await loadSchool(state.schoolKey);
  if (!s) { content("<div class='ms-empty'>Select a school.</div>"); return; }
  const b = s.buildings.find((x) => x.property_key === state.buildingKey) || s.buildings[0];
  if (!b) { content("<div class='ms-empty'>No building.</div>"); return; }
  state.buildingKey = b.property_key;

  const byYear = b.by_year || [];
  const years = byYear.map((y) => y.year);
  const stab = byYear.filter((y) => y.occ != null && y.occ >= 0.85);   // stabilized years only
  const canCum = stab.length >= 2;
  const monthsLbl = b.monthly.map((r) => r.month.slice(0, 7));
  // propYear null = Cumulative (default) when there are >=2 stabilized years.
  const cumulative = state.propYear == null && canCum;
  const selYear = (state.propYear != null && years.includes(state.propYear)) ? state.propYear
    : (cumulative ? null : (years.length ? years[years.length - 1] : null));

  const chips = `<div class="ms-chips" id="prop-years">` +
    (canCum ? `<span class="ms-chip ${selYear == null ? "active" : ""}" data-year="cum">Cumulative</span>` : "") +
    years.map((y) => `<span class="ms-chip ${y === selYear ? "active" : ""}" data-year="${y}">${y}</span>`).join("") +
    `</div>`;

  // Trend card + year table are shown in both modes.
  const trendCard = `
    <div class="ms-card">
      <h2>Trend Over Time (all years)</h2>
      <p class="sub">Monthly history, 2023-2026. The August dip in occupancy is the lease turn, not a real drop.</p>
      <div class="ms-grid">
        <div class="ms-chart"><h3>Rent / Bed</h3><div class="ms-chart-wrap"><canvas id="prop-rent"></canvas></div></div>
        <div class="ms-chart"><h3>Occupancy</h3><div class="ms-chart-wrap"><canvas id="prop-occ"></canvas></div></div>
        <div class="ms-chart"><h3>Prelease (upcoming term)</h3><div class="ms-chart-wrap"><canvas id="prop-pre"></canvas></div></div>
      </div>
    </div>`;
  const yearTableCard = `
    <div class="ms-card">
      <h2>Performance by Year</h2>
      <p class="sub">Each year anchored to the same month. Use the chips above to switch between the cumulative view and a single year.</p>
      ${chips}
      ${yearByTable(byYear)}
    </div>`;

  let head, detail;
  if (cumulative) {
    const base = stab[0], last = stab[stab.length - 1];
    const cumLayouts = cumLayoutGrowth(base.layouts, last.layouts);
    head = cumKpiBand(base, last, b, s);
    detail = `
      <div class="ms-card">
        <h2>Cumulative Rent Growth by Layout (${base.year} &rarr; ${last.year})</h2>
        <p class="sub">Total change in rent per bed by BRxBA layout across stabilized years. Bars colored by parity.</p>
        <div class="ms-grid"><div class="ms-chart"><h3>Cumulative Rent/Bed Change</h3><div class="ms-chart-wrap${cumLayouts.length > 8 ? " tall" : ""}"><canvas id="prop-cumlayout"></canvas></div></div></div>
        <div class="ms-table-wrap"><table class="ms-table">
          <thead><tr><th>Layout</th><th>${base.year} Rent/Bed</th><th>${last.year} Rent/Bed</th><th>Cumulative</th><th>Beds</th></tr></thead>
          <tbody>${cumLayouts.map((r) => `<tr><td>${esc(r.cat)}</td><td>${fUsd(r.base)}</td><td>${fUsd(r.last)}</td><td>${fPctSigned(r.cum)}</td><td>${fInt(r.beds)}</td></tr>`).join("")}</tbody>
        </table></div>
      </div>`;
  } else {
    const yr = byYear.find((y) => y.year === selYear) || b;
    const m = Object.assign({}, yr, { _parity: yr.parity || b.parity });
    head = kpiBand(m, [
      { l: "Building", v: esc(b.name), s: `${esc(s.market_name)} · delivered ${b.vintage}` },
      { l: "Beds / Units", v: `${fInt(yr.beds)} / ${fInt(yr.units)}`, s: b.miles_to_campus != null ? b.miles_to_campus.toFixed(1) + " mi to campus" : "" },
    ]);
    detail = `
      <div class="ms-card"><h2>Unit Types &mdash; ${selYear}</h2>${breakdownTable(yr.unit_types || b.unit_types, "Unit Type")}</div>
      <div class="ms-card"><h2>Parity &mdash; ${selYear}</h2>${breakdownTable(yr.parity || b.parity, "Class")}</div>
      ${layoutCard("prop", yr.layouts || b.layouts)}`;
  }

  content(head + yearTableCard + trendCard + detail);
  lineChart(document.getElementById("prop-rent"), monthsLbl, [{ label: "Rent/Bed", data: b.monthly.map((r) => r.rate_bed), borderColor: C.everest }], fUsd);
  lineChart(document.getElementById("prop-occ"), monthsLbl, [{ label: "Occupancy", data: b.monthly.map((r) => r.occ), borderColor: C.birch }], (v) => fPct(v, 0));
  lineChart(document.getElementById("prop-pre"), monthsLbl, [{ label: "Prelease", data: b.monthly.map((r) => r.prelease), borderColor: C.lime }], (v) => fPct(v, 0));
  if (cumulative) {
    const base = stab[0], last = stab[stab.length - 1];
    const cumLayouts = cumLayoutGrowth(base.layouts, last.layouts);
    const el = document.getElementById("prop-cumlayout");
    if (el) barChart(el, cumLayouts.map((l) => l.cat), cumLayouts.map((l) => l.cum),
      cumLayouts.map((l) => PARITY_COLOR[layoutParity(l.cat)] || C.slate30), (v) => fPctSigned(v), (v) => fPctSigned(v));
  } else {
    const yr = byYear.find((y) => y.year === selYear) || b;
    drawLayoutChart("prop", yr.layouts || b.layouts);
  }
  document.querySelectorAll("#prop-years .ms-chip").forEach((chip) =>
    chip.addEventListener("click", () => { state.propYear = chip.dataset.year === "cum" ? null : Number(chip.dataset.year); renderProperty(); }));
}

/* ----- shell -------------------------------------------------- */
function content(html) { clearCharts(); document.getElementById("ms-content").innerHTML = html; }

async function loadSchool(key) {
  if (!key) return null;
  if (SCHOOL_CACHE[key]) return SCHOOL_CACHE[key];
  try {
    const res = await fetch(`market-state/${key}.json`, { cache: "no-cache" });
    if (!res.ok) return null;
    const j = await res.json();
    SCHOOL_CACHE[key] = j;
    return j;
  } catch { return null; }
}

function render() {
  // toggle which filters show. Use display (not the hidden attr, which the
  // .ms-filter display rule overrides). School selector only on school/property;
  // building selector only on property.
  document.getElementById("ms-school-wrap").style.display = state.level === "national" ? "none" : "inline-flex";
  document.getElementById("ms-building-wrap").style.display = state.level === "property" ? "inline-flex" : "none";
  document.getElementById("ms-cohort").style.display = state.level === "national" ? "" : "none";
  document.getElementById("ms-vintages").style.display = state.level === "property" ? "none" : "";
  if (state.level === "national") { renderNational(); syncSelectors(); }
  else if (state.level === "school") renderSchool().then(syncSelectors);
  else renderProperty().then(syncSelectors);
}

function setLevel(level) {
  state.level = level;
  document.querySelectorAll("#ms-levels button").forEach((b) => b.classList.toggle("active", b.dataset.level === level));
  render();
}

async function syncSelectors() {
  const ssel = document.getElementById("ms-school");
  if (ssel && state.schoolKey) ssel.value = String(state.schoolKey);
  const bsel = document.getElementById("ms-building");
  if (bsel && state.level === "property") {
    const s = await loadSchool(state.schoolKey);
    if (s) {
      bsel.innerHTML = s.buildings.map((b) => `<option value="${b.property_key}">${esc(b.name)} (${b.vintage})</option>`).join("");
      if (state.buildingKey) bsel.value = String(state.buildingKey);
    }
  }
}

function buildVintageChips() {
  const box = document.getElementById("ms-vintages");
  const years = [2023, 2024, 2025, 2026];
  box.innerHTML = `<span class="ms-chip ${state.vintages.size === 0 ? "active" : ""}" data-v="all">All vintages</span>` +
    years.map((y) => `<span class="ms-chip ${state.vintages.has(y) ? "active" : ""}" data-v="${y}">${y}</span>`).join("");
  box.querySelectorAll(".ms-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const v = chip.dataset.v;
      if (v === "all") state.vintages.clear();
      else { const y = Number(v); state.vintages.has(y) ? state.vintages.delete(y) : state.vintages.add(y); }
      buildVintageChips();
      render();
    });
  });
}

async function init() {
  try {
    MANIFEST = await (await fetch("market-state/_manifest.json", { cache: "no-cache" })).json();
    COHORT = await (await fetch("market-state/_cohort.json", { cache: "no-cache" })).json();
    try { AMEN = await (await fetch("amenities/_rollup.json", { cache: "no-cache" })).json(); } catch { AMEN = null; }
  } catch (e) {
    content(`<div class='ms-empty'>Couldn't load Market State data. Has the builder run?<br><small>${esc(e)}</small></div>`);
    return;
  }
  document.getElementById("ms-asof").textContent = COHORT.as_of || "-";

  const ssel = document.getElementById("ms-school");
  ssel.innerHTML = MANIFEST.schools.map((s) => `<option value="${s.market_key}">${esc(s.market_name)} (${s.n_buildings})</option>`).join("");
  state.schoolKey = MANIFEST.schools[0] && MANIFEST.schools[0].market_key;
  ssel.addEventListener("change", () => { state.schoolKey = Number(ssel.value); state.buildingKey = null; state.propYear = null; render(); });
  document.getElementById("ms-building").addEventListener("change", (e) => { state.buildingKey = Number(e.target.value); state.propYear = null; render(); });

  document.querySelectorAll("#ms-levels button").forEach((b) => b.addEventListener("click", () => setLevel(b.dataset.level)));
  document.querySelectorAll("#ms-cohort button").forEach((b) => b.addEventListener("click", () => {
    state.cohort = b.dataset.cohort;
    document.querySelectorAll("#ms-cohort button").forEach((x) => x.classList.toggle("active", x === b));
    render();
  }));
  buildVintageChips();
  render();
}

init();
