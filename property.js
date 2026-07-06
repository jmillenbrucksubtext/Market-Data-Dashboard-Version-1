/* =============================================================
   Subtext Living - Property detail page
   URL: property.html?id=<property_key>
   Reads:
     data.json         core (properties, scorecard, campus_locations)
     plans/<id>.json   floor plans for this property only
   ============================================================= */

const NUM_FMT_INT = new Intl.NumberFormat("en-US");
const NUM_FMT_USD = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD",
  minimumFractionDigits: 0, maximumFractionDigits: 0,
});

// Shared phase palette (must match market.js)
const PHASE_STYLES = {
  "stable":             { shape: "diamond",  color: "#16352e", label: "Stabilized" },
  "lease up":           { shape: "square",   color: "#c1d100", label: "Lease Up" },
  "under construction": { shape: "triangle", color: "#a95818", label: "Under Construction" },
  "planned":            { shape: "pentagon", color: "#5a544f", label: "Planned" },
};
const PHASE_STYLE_DEFAULT = { shape: "circle", color: "#b6b1ab", label: "Unknown" };
function phaseStyle(phase) {
  return PHASE_STYLES[(phase || "").toLowerCase()] || PHASE_STYLE_DEFAULT;
}

let DATA = null;
let PROP = null;
let MARKET = null;
let PLANS = [];
let MIX = null;                        // this property's tables.unit_mix row
let planSortState = { col: "bedrooms", dir: "asc" };
let activeBedroomFilters = new Set();  // empty Set = show all

// Unit & Bed Mix section state (mirrors the market Comps-tab toggles).
let unitMixMetric = "units";           // "beds" | "units" - defaults to units
let unitMixParityType = "all";         // "all" | a bedroom type
let pmBarChart = null, pmSizeChart = null, pmPieChart = null, pmParityChart = null;

const BR_CATEGORY_ORDER = ["studio", "1", "2", "3", "4", "5", "6+"];

function bedroomCategory(plan) {
  if (plan.is_studio) return "studio";
  const b = Math.round(plan.bedrooms || 0);
  if (b >= 6) return "6+";
  if (b === 0) return "studio";   // some plans tag a 0-br as a studio
  return String(b);
}

function bedroomLabel(cat) {
  if (cat === "studio") return "Studio";
  if (cat === "6+")     return "6+ BR";
  return `${cat} BR`;
}

document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(location.search);
  const propertyKey = Number(params.get("id"));
  if (!propertyKey) return showError("No property specified.");

  try {
    const res = await fetch("data.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
  } catch (err) {
    return showError(`Couldn't load data.json - ${err}`);
  }

  PROP = DATA.tables.properties.find((p) => p.property_key === propertyKey);
  if (!PROP) return showError(`Property ${propertyKey} not found.`);

  MARKET = DATA.tables.scorecard.find((r) => r.market_key === PROP.market_key);

  MIX = (DATA.tables.unit_mix || []).find((r) => r.property_key === propertyKey) || null;

  try {
    const pRes = await fetch(`plans/${propertyKey}.json`, { cache: "no-cache" });
    if (pRes.ok) {
      PLANS = await pRes.json();
    }
  } catch { /* missing plans file is fine */ }

  document.getElementById("prop-loading").style.display = "none";
  document.getElementById("prop-view").style.display = "block";

  setFreshness();
  setBackLink();
  renderHeader();
  renderKpis();
  renderBedroomFilter();
  renderPlans();
  bindPlanSort();
  bindUnitMixToggle();
  renderUnitMix();

  if (typeof L === "undefined") {
    await new Promise((r) => window.addEventListener("load", r, { once: true }));
  }
  renderMap();
});

/* ----- Helpers ---------------------------------------------- */

function showError(msg) {
  document.getElementById("prop-loading").style.display = "none";
  const el = document.getElementById("prop-error");
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

function setBackLink() {
  if (!MARKET) return;
  const a = document.getElementById("back-link");
  a.href = `market.html?id=${MARKET.market_key}`;
  document.getElementById("back-label").textContent = `Back to ${MARKET.anchor_university}`;
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

/* ----- Header + KPIs ---------------------------------------- */

function renderHeader() {
  document.getElementById("prop-name").textContent = PROP.property_name || "(unnamed)";
  document.title = `SubHouse - ${PROP.property_name || "Property"}`;

  const addr = [PROP.street1, PROP.city, PROP.state].filter(Boolean).join(", ");
  const marketName = MARKET ? MARKET.anchor_university : "";
  const dot = marketName && addr ? " · " : "";
  document.getElementById("prop-subtitle").innerHTML =
    `${escapeHtml(addr)}${dot}<a href="market.html?id=${PROP.market_key}" class="market-back-link">${escapeHtml(marketName)} market →</a>`;

  // Phase badge in the header
  if (PROP.phase) {
    const s = phaseStyle(PROP.phase);
    const badge = document.getElementById("phase-badge");
    badge.style.display = "inline-flex";
    badge.style.setProperty("--phase-color", s.color);
    badge.innerHTML = `<span class="phase-dot" style="background:${s.color}"></span>${s.label}`;
  }

  // Contact pills (phone + marketing site) when the export provides them
  const contact = document.getElementById("prop-contact");
  if (contact && (PROP.phone || PROP.website)) {
    const iconPhone = `<svg class="contact-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
    const iconGlobe = `<svg class="contact-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
    const bits = [];
    if (PROP.phone) {
      const tel = String(PROP.phone).split("#")[0].replace(/[^\d+]/g, "");
      bits.push(`<a class="contact-pill" href="tel:${tel}">${iconPhone}${escapeHtml(PROP.phone)}</a>`);
    }
    if (PROP.website) {
      let label = PROP.website;
      try { label = new URL(PROP.website).hostname.replace(/^www\./, ""); } catch { /* keep raw url */ }
      bits.push(`<a class="contact-pill" href="${escapeHtml(PROP.website)}" target="_blank" rel="noopener">${iconGlobe}${escapeHtml(label)}</a>`);
    }
    contact.style.display = "flex";
    contact.innerHTML = bits.join("");
  }
}

function renderKpis() {
  document.getElementById("kpi-beds").textContent = fmtInt(PROP.beds);
  document.getElementById("kpi-units-sub").textContent =
    PROP.units ? `${fmtInt(PROP.units)} units` : "-";

  document.getElementById("kpi-year").textContent = fmtYear(PROP.yearBuilt);
  if (PROP.yearBuilt) {
    const age = new Date().getFullYear() - PROP.yearBuilt;
    document.getElementById("kpi-age-sub").textContent = `${age} yr${age === 1 ? "" : "s"} old`;
  } else {
    document.getElementById("kpi-age-sub").textContent = "-";
  }

  document.getElementById("kpi-occ").textContent = fmtPct(PROP.occupancy);
  document.getElementById("kpi-pre").textContent = fmtPct(PROP.prelease);

  document.getElementById("kpi-rent").textContent = fmtUsd(PROP.avg_rent);
  document.getElementById("kpi-rent-sub").textContent =
    PROP.avg_rent_per_sf != null ? `$${fmtNum(PROP.avg_rent_per_sf, 2)}/SF` : "-";

  document.getElementById("kpi-dist").textContent =
    PROP.milesToClosestCampus != null ? `${fmtNum(PROP.milesToClosestCampus, 1)} mi` : "-";
  document.getElementById("kpi-google-sub").textContent =
    PROP.currentGoogleReviewAvg != null
      ? `Google ★ ${fmtNum(PROP.currentGoogleReviewAvg, 1)} (${fmtInt(PROP.google_review_count)} reviews)`
      : "-";
}

/* ----- Plans table ------------------------------------------ */

function bindPlanSort() {
  document.querySelectorAll("#plans thead th").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      if (planSortState.col === col) {
        planSortState.dir = planSortState.dir === "asc" ? "desc" : "asc";
      } else {
        planSortState.col = col;
        planSortState.dir = th.dataset.type === "num" ? "desc" : "asc";
      }
      renderPlans();
    });
  });
}

function renderBedroomFilter() {
  const container = document.getElementById("bedroom-filter");
  if (!container) return;
  if (PLANS.length === 0) { container.innerHTML = ""; return; }

  const cats = new Set(PLANS.map(bedroomCategory));
  const available = BR_CATEGORY_ORDER.filter((c) => cats.has(c));

  // count per category
  const counts = {};
  PLANS.forEach((p) => {
    const c = bedroomCategory(p);
    counts[c] = (counts[c] || 0) + 1;
  });

  const allActive = activeBedroomFilters.size === 0;
  const chips = [
    `<button class="chip ${allActive ? "chip-active" : ""}" data-br="__all__">All <span class="chip-count">${PLANS.length}</span></button>`,
    ...available.map((c) => `
      <button class="chip ${activeBedroomFilters.has(c) ? "chip-active" : ""}" data-br="${c}">
        ${bedroomLabel(c)} <span class="chip-count">${counts[c]}</span>
      </button>
    `),
  ];
  container.innerHTML = `<span class="filter-label">Bedrooms:</span>${chips.join("")}`;

  container.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.br;
      if (v === "__all__") {
        activeBedroomFilters.clear();
      } else if (activeBedroomFilters.has(v)) {
        activeBedroomFilters.delete(v);
      } else {
        activeBedroomFilters.add(v);
      }
      renderBedroomFilter();
      renderPlans();
    });
  });
}

function visiblePlans() {
  if (activeBedroomFilters.size === 0) return PLANS;
  return PLANS.filter((p) => activeBedroomFilters.has(bedroomCategory(p)));
}

function renderPlans() {
  const tbody = document.querySelector("#plans tbody");
  document.querySelectorAll("#plans thead th").forEach((th) => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.sort === planSortState.col) {
      th.classList.add(planSortState.dir === "asc" ? "sorted-asc" : "sorted-desc");
    }
  });

  const filtered = visiblePlans();

  if (PLANS.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-state">No floor plans recorded for this property.</td></tr>`;
    document.getElementById("plan-count").textContent = "0 floor plans";
    return;
  }
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-state">No floor plans match the selected bedroom filter.</td></tr>`;
    document.getElementById("plan-count").textContent = `0 of ${PLANS.length} floor plans`;
    return;
  }

  const { col, dir } = planSortState;
  const sign = dir === "asc" ? 1 : -1;
  const rows = filtered.slice().sort((a, b) => {
    const av = a[col], bv = b[col];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number") return (av - bv) * sign;
    if (typeof av === "boolean") return (Number(av) - Number(bv)) * sign;
    return String(av).localeCompare(String(bv)) * sign;
  });

  tbody.innerHTML = rows.map((p) => {
    const concessionsCell = p.has_concessions
      ? `<span class="band-pill band-Balanced" title="${escapeHtml(p.concessions_notes || "")}">${p.concessions_value != null ? fmtUsd(p.concessions_value) : "Yes"}</span>`
      : '<span class="delta flat">-</span>';
    return `
      <tr>
        <td class="property-cell">
          ${escapeHtml(p.plan_name || "(unnamed)")}
          <span class="city-state">${escapeHtml(p.unit_type_name || "")}</span>
        </td>
        <td class="num">${p.is_studio ? "Studio" : fmtNum(p.bedrooms, 0)}</td>
        <td class="num">${fmtNum(p.bathrooms, 1)}</td>
        <td class="num">${fmtInt(p.area_sf)}</td>
        <td class="num">${fmtUsd(p.rate)}</td>
        <td class="num">${p.rate_per_sf != null ? "$" + fmtNum(p.rate_per_sf, 2) : "-"}</td>
        <td class="num">${fmtPct(p.prelease)}</td>
        <td class="num">${fmtPct(p.occupancy)}</td>
        <td>${concessionsCell}</td>
        <td class="num">${fmtInt(p.beds_in_plan)}</td>
      </tr>`;
  }).join("");

  const totalLabel = filtered.length === PLANS.length
    ? `${rows.length} floor plan${rows.length === 1 ? "" : "s"}`
    : `${rows.length} of ${PLANS.length} floor plans`;
  document.getElementById("plan-count").textContent =
    `${totalLabel} · sorted by ${planSortState.col} ${planSortState.dir}`;
}

/* ----- Unit & Bed Mix --------------------------------------- */
// The market Comps-tab "Unit & Bed Mix" section, scoped to this one
// property: a bar of beds/units by bedroom type, a unit-mix doughnut, a
// bed/bath parity doughnut (filterable by bedroom type), and a summary
// table. Toggles between authoritative bed counts and derived unit counts.
// Data: this property's row in tables.unit_mix (MIX). Mirrors renderUnitMix()
// et al. in market.js so the two views stay visually consistent.

const UNIT_MIX_TYPES = ["Studio", "1BR", "2BR", "3BR", "4BR", "5BR", "6BR+"];

// Fixed colour per bedroom type (matches market.js UNIT_TYPE_COLORS).
const UNIT_TYPE_COLORS = {
  "Studio": "#6d5b8e",
  "1BR": "#3d8aa6",
  "2BR": "#4f7a6f",
  "3BR": "#c7973f",
  "4BR": "#a95818",
  "5BR": "#16352e",
  "6BR+": "#9c4a3c",
};

// Parity slice colours: full = everest (good), none = birch (shared baths).
const PARITY_COLORS = { full: "#16352e", partial: "#a95818" };

function renderUnitMix() {
  const card = document.getElementById("unitmix-card");
  if (!card) return;

  // No floor-plan mix for this property → hide the whole section.
  if (!MIX || typeof Chart === "undefined") {
    card.style.display = "none";
    return;
  }
  card.style.display = "";

  // The doughnuts draw on-slice labels via chartjs-plugin-datalabels, which
  // does not auto-register with Chart.js v4. Register once (the bar opts out
  // with datalabels:{display:false}, so labels can't leak onto it).
  if (window.ChartDataLabels) Chart.register(window.ChartDataLabels);

  const metric = unitMixMetric;                          // "beds" | "units"
  const field = metric === "beds" ? "beds_by_type" : "units_by_type";
  const noun = metric === "beds" ? "beds" : "units";
  const metricLabel = metric === "beds" ? "Beds" : "Units";
  const mix = MIX[field] || {};

  const typesPresent = UNIT_MIX_TYPES.filter((t) => mix[t]);
  const total = typesPresent.reduce((s, t) => s + (mix[t] || 0), 0);

  // Summary line + toggle/title sync.
  const summaryEl = document.getElementById("pm-summary");
  if (summaryEl) {
    summaryEl.textContent = total === 0
      ? "No floor-plan data recorded for this property."
      : `${fmtInt(total)} ${noun} across ${typesPresent.length} bedroom type${typesPresent.length === 1 ? "" : "s"}.`;
  }
  document.querySelectorAll(".unitmix-toggle-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mix === metric));
  const pieTitle = document.getElementById("pm-pie-title");
  if (pieTitle) pieTitle.textContent = `Unit Mix (${metricLabel})`;
  const sumTitle = document.getElementById("pm-summary-title");
  if (sumTitle) sumTitle.textContent = `${metricLabel} by Type`;

  renderUnitMixBar(typesPresent, mix, noun, metric);
  renderUnitSizeBar();
  renderUnitMixPie(typesPresent, mix, noun);
  populateUnitMixParityPicker();
  renderUnitMixParityPie();
  renderUnitMixSummaryTable(typesPresent, mix, metricLabel, total);
}

// Average unit size (sf) for this property by exact unit type (#BR / #BA),
// so a 4x4 is a distinct bar from a 4x2. Independent of the By Bed/By Unit
// toggle. Hidden when no floor plan carries a usable area.
function renderUnitSizeBar() {
  const figure = document.getElementById("pm-size-figure");
  const canvas = document.getElementById("pm-size");
  if (!figure || !canvas) return;

  const cats = (MIX.size_by_unit || [])
    .filter((c) => c.avg_sf)
    .map((c) => ({
      label: c.label,
      color: UNIT_TYPE_COLORS[c.cat] || "#837c75",
      value: c.avg_sf,
      units: c.units || 0,
    }));

  if (cats.length === 0) {
    figure.style.display = "none";
    if (pmSizeChart) { pmSizeChart.destroy(); pmSizeChart = null; }
    return;
  }
  figure.style.display = "";

  const values = cats.map((c) => c.value);

  const totalsPlugin = {
    id: "pmSizeTotals",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data) return;
      ctx.save();
      ctx.fillStyle = "#16352e";
      ctx.font = "700 13px Pragmatica, sans-serif";
      ctx.textAlign = "center";
      meta.data.forEach((bar, i) => {
        const v = values[i];
        if (!v) return;
        ctx.fillText(`${fmtInt(v)} SF`, bar.x, bar.y - 6);
      });
      ctx.restore();
    },
  };

  if (pmSizeChart) pmSizeChart.destroy();
  pmSizeChart = new Chart(canvas.getContext("2d"), {
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
          callbacks: { label: (c) => `${fmtInt(c.parsed.y)} sf avg` },
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

// Bar: x = bedroom type, one value per type, coloured by type. The count
// sits above each bar (datalabels stay off, like the market stacked bar).
function renderUnitMixBar(typesPresent, mix, noun, metric) {
  const canvas = document.getElementById("pm-bar");
  if (!canvas) return;

  const values = typesPresent.map((t) => mix[t] || 0);

  const totalsPlugin = {
    id: "pmBarTotals",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data) return;
      ctx.save();
      ctx.fillStyle = "#16352e";
      ctx.font = "700 13px Pragmatica, sans-serif";
      ctx.textAlign = "center";
      meta.data.forEach((bar, i) => {
        const v = values[i];
        if (!v) return;
        ctx.fillText(fmtInt(v), bar.x, bar.y - 6);
      });
      ctx.restore();
    },
  };

  if (pmBarChart) pmBarChart.destroy();
  pmBarChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: typesPresent,
      datasets: [{
        label: metric === "beds" ? "Beds" : "Units",
        data: values,
        backgroundColor: typesPresent.map((t) => UNIT_TYPE_COLORS[t] || "#837c75"),
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
          callbacks: { label: (c) => `${fmtInt(c.parsed.y)} ${noun}` },
        },
        datalabels: { display: false },
      },
      scales: {
        x: { grid: { display: false, drawBorder: false }, border: { display: false },
             ticks: { font: { size: 13, weight: 600, family: "Pragmatica, sans-serif" }, color: "#2b2825" } },
        y: { beginAtZero: true,
             title: { display: true, text: metric === "beds" ? "Bed Count" : "Unit Count",
                      font: { size: 11, family: "Pragmatica, sans-serif" }, color: "#5a544f" },
             grid: { color: "#f5efde", drawTicks: false }, border: { display: false },
             ticks: { color: "#5a544f", font: { size: 11 } } },
      },
    },
    plugins: [totalsPlugin],
  });
}

/* Nested unit-mix doughnut: inner ring = bedroom type, outer ring = each type
   split into en-suite (solid) vs shared-bath (lighter shade). Both rings are
   derived from this property's parity_by_type so they reconcile exactly. */
function buildNestedMixConfig(perType, noun) {
  const types = UNIT_MIX_TYPES.filter((t) => perType[t] && (perType[t].full + perType[t].partial) > 0);
  const total = types.reduce((s, t) => s + perType[t].full + perType[t].partial, 0);
  if (!total) return null;

  const innerData = types.map((t) => perType[t].full + perType[t].partial);
  const innerColors = types.map((t) => UNIT_TYPE_COLORS[t] || "#837c75");

  const outerData = [], outerColors = [], outerMeta = [];
  types.forEach((t) => {
    const base = UNIT_TYPE_COLORS[t] || "#837c75";
    outerData.push(perType[t].full);    outerColors.push(base);        outerMeta.push({ type: t, kind: "en-suite", val: perType[t].full });
    outerData.push(perType[t].partial); outerColors.push(base + "80"); outerMeta.push({ type: t, kind: "shared bath", val: perType[t].partial });
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
          onClick: () => {},
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

function renderUnitMixPie(typesPresent, mix, noun) {
  const canvas = document.getElementById("pm-pie");
  if (!canvas) return;

  const useBeds = noun === "beds";
  const fullKey = useBeds ? "beds_full" : "units_full";
  const partKey = useBeds ? "beds_partial" : "units_partial";
  const pbt = MIX.parity_by_type || {};
  const perType = {};
  UNIT_MIX_TYPES.forEach((t) => {
    const e = pbt[t]; if (!e) return;
    perType[t] = { full: e[fullKey] || 0, partial: e[partKey] || 0 };
  });

  if (pmPieChart) { pmPieChart.destroy(); pmPieChart = null; }
  const config = buildNestedMixConfig(perType, noun);
  if (!config) {
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  pmPieChart = new Chart(canvas.getContext("2d"), config);
}

// Bed/bath parity picker: bedroom types present in this property's parity data.
function populateUnitMixParityPicker() {
  const sel = document.getElementById("pm-parity-type");
  if (!sel) return;
  const pbt = MIX.parity_by_type || {};
  const present = UNIT_MIX_TYPES.filter((t) => pbt[t]);
  if (unitMixParityType !== "all" && !present.includes(unitMixParityType)) {
    unitMixParityType = "all";
  }
  const opts = [`<option value="all">All bedroom types</option>`].concat(
    present.map((t) => `<option value="${t}">${t}</option>`));
  sel.innerHTML = opts.join("");
  sel.value = unitMixParityType;
}

// Parity doughnut: share of beds (or units) where every bedroom has its own
// bath. Filterable by bedroom type.
function renderUnitMixParityPie() {
  const canvas = document.getElementById("pm-parity-pie");
  if (!canvas) return;
  const titleEl = document.getElementById("pm-parity-title");

  const useBeds = unitMixMetric === "beds";
  const fullKey = useBeds ? "beds_full" : "units_full";
  const partialKey = useBeds ? "beds_partial" : "units_partial";
  const noun = useBeds ? "beds" : "units";
  const metricLabel = useBeds ? "Beds" : "Units";

  const pbt = MIX.parity_by_type || {};
  const types = unitMixParityType === "all" ? Object.keys(pbt) : [unitMixParityType];
  let full = 0, partial = 0;
  types.forEach((t) => {
    if (!pbt[t]) return;
    full += pbt[t][fullKey] || 0;
    partial += pbt[t][partialKey] || 0;
  });
  const total = full + partial;

  const scope = unitMixParityType === "all" ? "" : ` - ${unitMixParityType}`;
  if (titleEl) titleEl.textContent = `Bed / Bath Parity${scope} (${metricLabel})`;

  if (pmParityChart) pmParityChart.destroy();
  if (!total) {
    pmParityChart = null;
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  pmParityChart = new Chart(canvas.getContext("2d"), {
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

// Summary table: bedroom type × [count, % of total].
function renderUnitMixSummaryTable(typesPresent, mix, metricLabel, total) {
  const table = document.getElementById("pm-summary-table");
  if (!table) return;

  if (total === 0) {
    table.innerHTML = `<tbody><tr><td>No floor-plan data for this property.</td></tr></tbody>`;
    return;
  }
  const pct = (v) => (total ? (v / total * 100).toFixed(1) + "%" : "-");
  const head = `<thead><tr><th class="property-cell">Type</th><th>${metricLabel}</th><th>% of total</th></tr></thead>`;
  const body = typesPresent.map((t) =>
    `<tr><td class="property-cell">${t}</td><td>${fmtInt(mix[t] || 0)}</td><td>${pct(mix[t] || 0)}</td></tr>`
  ).join("");
  const foot = `<tfoot><tr class="agg-row"><td class="property-cell">Total</td><td>${fmtInt(total)}</td><td>100.0%</td></tr></tfoot>`;
  table.innerHTML = head + `<tbody>${body}</tbody>` + foot;
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

  // Bedroom-type filter for the parity pie. The <select> persists across
  // renders (only its options are rebuilt), so this listener stays attached.
  const parSel = document.getElementById("pm-parity-type");
  if (parSel) {
    parSel.addEventListener("change", () => {
      unitMixParityType = parSel.value;
      renderUnitMixParityPie();
    });
  }
}

/* ----- Map -------------------------------------------------- */

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

async function renderMap() {
  if (typeof L === "undefined") return;
  if (PROP.latitude == null || PROP.longitude == null) {
    document.getElementById("map").innerHTML =
      `<div class="empty-state">No coordinates on file for this property.</div>`;
    return;
  }

  const map = L.map("map", {
    center: [PROP.latitude, PROP.longitude],
    zoom: 14,
    scrollWheelZoom: true,
    minZoom: 10,            // keep the property's city in view
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
  // Default to Satellite for property view - visually richest at building scale
  baseLayers.Satellite.addTo(map);
  L.control.layers(baseLayers, null, { position: "topright", collapsed: true }).addTo(map);
  addFullscreenControl(map);

  const bounds = [];

  // Campus boundary (if available for this market)
  if (PROP.market_key) {
    try {
      const gjRes = await fetch(`assets/campus-boundaries/${PROP.market_key}.geojson`, { cache: "no-cache" });
      if (gjRes.ok) {
        const gj = await gjRes.json();
        const layer = L.geoJSON(gj, {
          style: {
            color: "#d32f2f", weight: 2, opacity: 0.9,
            fillColor: "#d32f2f", fillOpacity: 0.15,
          },
          interactive: false,
        }).addTo(map);
        const b = layer.getBounds();
        if (b.isValid()) bounds.push([b.getNorth(), b.getEast()], [b.getSouth(), b.getWest()]);
      }
    } catch { /* missing boundary is fine */ }
  }

  // Property marker (phase-styled, larger size to stand out as the hero)
  const s = phaseStyle(PROP.phase);
  const svg = (() => {
    const stroke = "white", sw = 2, size = 28;
    switch (s.shape) {
      case "diamond":   return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><polygon points="8,1 15,8 8,15 1,8" fill="${s.color}" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
      case "square":    return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><rect x="2.5" y="2.5" width="11" height="11" fill="${s.color}" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
      case "triangle":  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><polygon points="8,1.5 14.5,14 1.5,14" fill="${s.color}" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
      case "pentagon":  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><polygon points="8,1.5 14.5,6.5 12,14.5 4,14.5 1.5,6.5" fill="${s.color}" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
      default:          return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><circle cx="8" cy="8" r="6" fill="${s.color}" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
    }
  })();
  L.marker([PROP.latitude, PROP.longitude], {
    icon: L.divIcon({
      className: "leaflet-prop-pin",
      html: svg,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    }),
    zIndexOffset: 1000,
  }).addTo(map);
  bounds.push([PROP.latitude, PROP.longitude]);

  if (bounds.length > 1) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }
}
