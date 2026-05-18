/* =============================================================
   Subtext Living — Market Data Dashboard (client)
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
let activeMarketKey = null;
let sortState = { col: "penetration_ratio", dir: "asc" };
let charts = {};

// National map state
let industryMap = null;
let industryMarkerLayer = null;

// Analysis tab state
let analysisSortState = { col: "ic_date", dir: "desc" };
let activeCategory = "Future Analyses";  // single-select; defaults to forward-looking pipeline
let analysisSearchQuery = "";

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const res = await fetch("data.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
  } catch (err) {
    document.body.innerHTML =
      `<div class="empty-state">Couldn't load data.json — ${err}</div>`;
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

  setFreshness();
  bindUI();
  bindNav();
  bindAnalysisSort();
  renderAll();
});

/* ----- View routing ------------------------------------------ */

const VALID_VIEWS = ["industry", "analysis", "sources"];

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
  // scroll to top of content on view switch
  window.scrollTo({ top: 0, behavior: "instant" });
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
  if (v == null || isNaN(v)) return "—";
  return (v * 100).toFixed(digits) + "%";
}
function fmtInt(v) {
  if (v == null || isNaN(v)) return "—";
  return NUM_FMT_INT.format(Math.round(v));
}
function fmtUsd(v) {
  if (v == null || isNaN(v)) return "—";
  return NUM_FMT_USD.format(v);
}
function deltaSpan(v) {
  if (v == null) return `<span class="delta flat">—</span>`;
  const cls = v > 0.005 ? "up" : v < -0.005 ? "down" : "flat";
  const arr = v > 0.005 ? "▲" : v < -0.005 ? "▼" : "";
  return `<span class="delta ${cls}"><span class="arrow">${arr}</span>${fmtPct(v)}</span>`;
}

function qualifierPill(row) {
  if (row.qualifier_score == null) return `<span class="qual-mini qual-mini-na">—</span>`;
  const pct = Math.round(row.qualifier_score * 100);
  const tier = pct >= 80 ? "good" : pct >= 60 ? "warn" : "bad";
  const label = `${row.qualifier_passes}/${row.qualifier_evaluable}`;
  return `<span class="qual-mini qual-mini-${tier}" title="${label} of evaluable Subtext qualifiers passing">${pct}%</span>`;
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
  const subtext30 = document.getElementById("subtext30-only").checked;
  const power4 = document.getElementById("power4-only").checked;

  if (q) {
    rows = rows.filter((r) =>
      (r.anchor_university || "").toLowerCase().includes(q) ||
      (r.city || "").toLowerCase().includes(q) ||
      (r.state_abbr || "").toLowerCase().includes(q),
    );
  }
  if (subtext30) {
    rows = rows.filter((r) => r.is_subtext30 === 1);
  }
  if (power4) {
    rows = rows.filter((r) => POWER4_ANCHORS.has(r.anchor_university));
  }

  // Attach yoy_rent_growth from rent_yoy
  const yoyByKey = new Map(
    DATA.tables.rent_yoy.map((r) => [r.market_key, r.yoy_rent_growth]),
  );
  // Attach qualifier score (% passing of evaluable)
  const qualByKey = new Map(
    (DATA.tables.market_qualifiers || []).map((q) => [q.market_key, q]),
  );
  // Attach affluence (mean origin income) — null when sample is too small
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

/* ----- UI bindings ------------------------------------------- */

function bindUI() {
  document.getElementById("market-filter").addEventListener("input", renderAll);
  const cb = document.getElementById("subtext30-only");
  const label = document.getElementById("subtext-toggle-label");
  cb.addEventListener("change", () => {
    label.classList.toggle("active", cb.checked);
    renderAll();
  });
  const p4 = document.getElementById("power4-only");
  const p4Label = document.getElementById("power4-toggle-label");
  p4.addEventListener("change", () => {
    p4Label.classList.toggle("active", p4.checked);
    renderAll();
  });

  document.querySelectorAll("#scorecard thead th").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      if (sortState.col === col) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState.col = col;
        sortState.dir = th.dataset.type === "num" ? "desc" : "asc";
      }
      renderAll();
    });
  });
}

/* ----- KPI strip --------------------------------------------- */

function renderKpis(rows) {
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
    rows.length ? `${fmtInt(avgBeds)} avg per market` : "—";

  // Pipeline beds total
  const pipe = rows.reduce((a, r) => a + (r.beds_pipeline_total || 0), 0);
  document.getElementById("kpi-pipeline").textContent = fmtInt(pipe);
  const pipePct = beds > 0 ? (pipe / beds) : null;
  document.getElementById("kpi-pipeline-sub").textContent =
    pipePct != null ? `${fmtPct(pipePct, 0)} of existing supply` : "—";

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
    weight > 0 ? `weighted by ${fmtInt(weight)} beds` : "—";

  // page subtitle — element optional (was removed from layout)
  const mc = document.getElementById("market-count");
  if (mc) mc.textContent = fmtInt(totalMarkets);
}

/* ----- Scorecard table --------------------------------------- */

function renderScorecard(rows) {
  const tbody = document.querySelector("#scorecard tbody");
  document.querySelectorAll("#scorecard thead th").forEach((th) => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.sort === sortState.col) {
      th.classList.add(sortState.dir === "asc" ? "sorted-asc" : "sorted-desc");
    }
  });

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">No markets match the filter.</td></tr>`;
  } else {
    tbody.innerHTML = rows
      .map((r) => {
        const selected = r.market_key === activeMarketKey ? " selected" : "";
        const star = r.is_subtext30 === 1
          ? `<span class="s30-star" title="Subtext-30 focus market">★</span>` : "";
        const affTitle = r.affluence_n != null
          ? (r.pct_hiinc != null
              ? `${fmtPct(r.pct_hiinc)} from high-income tracts · n=${fmtInt(r.affluence_n)}`
              : `n=${fmtInt(r.affluence_n)} students`)
          : "no migration data";
        return `
          <tr class="${selected.trim()}" data-market-key="${r.market_key}">
            <td class="university-cell">
              ${star}${escapeHtml(r.anchor_university || "")}
              <span class="city-state">${escapeHtml([r.city, r.state_abbr].filter(Boolean).join(", "))}</span>
            </td>
            <td class="num">${qualifierPill(r)}</td>
            <td class="num">${fmtPct(r.penetration_ratio)}</td>
            <td class="num">${fmtInt(r.total_enrollment)}</td>
            <td class="num">${fmtInt(r.existing_beds)}</td>
            <td class="num">${fmtUsd(r.avg_rent_per_bed)}</td>
            <td class="num">${deltaSpan(r.yoy_rent_growth)}</td>
            <td class="num">${fmtInt(r.beds_pipeline_total)}</td>
            <td class="num" title="${affTitle}">${fmtUsd(r.mean_origin_income)}</td>
          </tr>`;
      })
      .join("");
    // Clicking a row opens the market detail page (real navigation).
    tbody.querySelectorAll("tr").forEach((tr) => {
      tr.addEventListener("click", () => {
        const key = Number(tr.dataset.marketKey);
        window.location.href = `market.html?id=${key}`;
      });
    });
  }

  document.getElementById("result-count").textContent =
    `Showing ${rows.length} of ${DATA.tables.scorecard.length} markets`;
}

/* ----- Charts ------------------------------------------------ */

function bandColor(pen) {
  if (pen == null) return C.slate30;
  if (pen < 0.30) return C.everest;   // under-supplied = opportunity
  if (pen > 0.55) return C.birch;     // over-supplied = avoid
  return C.warn;                      // balanced
}

function renderPenetration(rows) {
  const top = rows.filter((r) => r.penetration_ratio != null)
    .sort((a, b) => a.penetration_ratio - b.penetration_ratio)
    .slice(0, 30);
  const ctx = document.getElementById("penetration-chart");
  if (charts.penetration) charts.penetration.destroy();
  charts.penetration = new Chart(ctx, {
    type: "bar",
    data: {
      labels: top.map((r) => r.anchor_university),
      datasets: [{
        data: top.map((r) => r.penetration_ratio),
        backgroundColor: top.map((r) => bandColor(r.penetration_ratio)),
        borderRadius: 4,
        barThickness: 12,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => fullLabel(rowKey(top, items[0].dataIndex)),
            label: (ctx) => `Penetration: ${fmtPct(ctx.parsed.x)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { callback: (v) => fmtPct(v, 0) },
          grid: { color: C.beigeDeep, drawBorder: false },
        },
        y: {
          ticks: { autoSkip: false, font: { size: 11 } },
          grid: { display: false },
        },
      },
    },
  });
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
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            title: (items) => fullLabel(rowKey(top, items[0].dataIndex)),
            label: (ctx) => `${ctx.dataset.label}: ${fmtInt(ctx.parsed.x)} beds`,
          },
        },
      },
      scales: {
        x: { stacked: true, ticks: { callback: (v) => fmtInt(v) },
             grid: { color: C.beigeDeep, drawBorder: false } },
        y: { stacked: true, ticks: { autoSkip: false, font: { size: 10 } },
             grid: { display: false } },
      },
    },
  });
}

function renderDemand(rows) {
  const visibleKeys = new Set(rows.map((r) => r.market_key));
  const trends = DATA.tables.enrollment_trend
    .filter((t) => visibleKeys.has(t.market_key))
    .filter((t) => t.current_enrollment != null)
    .sort((a, b) => b.current_enrollment - a.current_enrollment)
    .slice(0, 30);

  const ctx = document.getElementById("demand-chart");
  if (charts.demand) charts.demand.destroy();
  charts.demand = new Chart(ctx, {
    type: "bar",
    data: {
      labels: trends.map((t) => t.university_name),
      datasets: [{
        data: trends.map((t) => (t.cagr_5yr != null ? t.cagr_5yr * 100 : 0)),
        backgroundColor: trends.map((t) => (t.cagr_5yr || 0) >= 0 ? C.good : C.bad),
        borderRadius: 4,
        barThickness: 12,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => trends[items[0].dataIndex].university_name,
            label: (ctx) => {
              const t = trends[ctx.dataIndex];
              return [
                `Current enrollment: ${fmtInt(t.current_enrollment)}`,
                `YoY: ${fmtPct(t.yoy_change)}`,
                `5-yr CAGR: ${fmtPct(t.cagr_5yr)}`,
              ];
            },
          },
        },
      },
      scales: {
        x: { ticks: { callback: (v) => v.toFixed(1) + "%" },
             grid: { color: C.beigeDeep, drawBorder: false } },
        y: { ticks: { autoSkip: false, font: { size: 10 } },
             grid: { display: false } },
      },
    },
  });
}

function renderPricing(rows) {
  const yoyByKey = new Map(DATA.tables.rent_yoy.map((r) => [r.market_key, r.yoy_rent_growth]));
  const top = rows.filter((r) => r.avg_rent_per_bed != null)
    .sort((a, b) => (b.avg_rent_per_bed || 0) - (a.avg_rent_per_bed || 0))
    .slice(0, 30);

  const ctx = document.getElementById("pricing-chart");
  if (charts.pricing) charts.pricing.destroy();
  charts.pricing = new Chart(ctx, {
    type: "bar",
    data: {
      labels: top.map((r) => r.anchor_university),
      datasets: [
        {
          label: "Avg rent / bed",
          data: top.map((r) => Number(r.avg_rent_per_bed) || 0),
          backgroundColor: C.everest,
          yAxisID: "y",
          borderRadius: 4,
          barThickness: 10,
        },
        {
          label: "YoY rent growth",
          data: top.map((r) => {
            const v = yoyByKey.get(r.market_key);
            return v == null ? 0 : v * 100;
          }),
          backgroundColor: top.map((r) => {
            const v = yoyByKey.get(r.market_key);
            return v == null ? C.slate30 : v >= 0 ? C.good : C.bad;
          }),
          yAxisID: "y1",
          borderRadius: 4,
          barThickness: 10,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            title: (items) => fullLabel(rowKey(top, items[0].dataIndex)),
            label: (ctx) => {
              if (ctx.dataset.yAxisID === "y") return `Avg rent: ${fmtUsd(ctx.parsed.y)}`;
              return `YoY: ${ctx.parsed.y.toFixed(1)}%`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { autoSkip: false, font: { size: 10 }, maxRotation: 70, minRotation: 70 },
             grid: { display: false } },
        y: { position: "left",
             ticks: { callback: (v) => fmtUsd(v) },
             grid: { color: C.beigeDeep, drawBorder: false },
             title: { display: true, text: "Avg rent ($)", color: C.slate70 } },
        y1: { position: "right",
              grid: { drawOnChartArea: false },
              ticks: { callback: (v) => v.toFixed(0) + "%" },
              title: { display: true, text: "YoY growth (%)", color: C.slate70 } },
      },
    },
  });
}

/* ----- Pre-leasing velocity ---------------------------------- */

function renderVelocity() {
  const select = document.getElementById("velocity-market");
  if (select.options.length === 0) {
    // List markets that have prelease data — labeled by anchor university.
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
        legend: { position: "bottom" },
        tooltip: {
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%` },
        },
      },
      scales: {
        x: { type: "linear",
             title: { display: true, text: "ISO week of year", color: C.slate70 },
             min: 1, max: 53,
             ticks: { stepSize: 4 },
             grid: { color: C.beigeDeep, drawBorder: false } },
        y: { title: { display: true, text: "Pre-leased %", color: C.slate70 },
             ticks: { callback: (v) => v + "%" },
             min: 0, max: 100,
             grid: { color: C.beigeDeep, drawBorder: false } },
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

function renderIndustryMap() {
  const el = document.getElementById("industry-map");
  if (!el) return;
  if (typeof L === "undefined") {
    // Leaflet still loading — try again once page load finishes
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

    // Multiple basemap options — switch via the layer control in the corner.
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

    // State outlines overlay — non-interactive, thin contrasting stroke so it
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

  for (const r of rows) {
    const coords = ANCHOR_COORDS.get(r.market_key);
    if (!coords) continue;
    const isS30 = r.is_subtext30 === 1;
    const marker = L.circleMarker([coords.lat, coords.lng], {
      radius: isS30 ? 9 : 6,
      fillColor: pinColor(r.qualifier_score),
      color: isS30 ? "#c1d100" : "#ffffff",        // lime ring for Subtext-30, white for others
      weight: isS30 ? 3 : 1.5,
      fillOpacity: 0.92,
    });
    const score = r.qualifier_score == null
      ? "—"
      : `${Math.round(r.qualifier_score * 100)}% qualifier score`;
    marker.bindPopup(`
      <strong>${escapeHtml(r.anchor_university || "")}</strong><br>
      ${escapeHtml(r.city || "")}, ${escapeHtml(r.state_abbr || "")}<br>
      ${fmtInt(r.existing_beds)} existing beds · ${fmtUsd(r.avg_rent_per_bed)} avg rent<br>
      ${score}${isS30 ? " · ⭐ Subtext-30" : ""}<br>
      <a href="market.html?id=${r.market_key}" class="popup-link">Open market →</a>
    `);
    marker.on("click", () => marker.openPopup());
    marker.addTo(industryMarkerLayer);
  }
}

/* ----- Analysis tab ----------------------------------------- */

function analysisRows() {
  const all = (DATA.tables.market_analysis_schedule || []).slice();
  const byCategory = all.filter((r) => (r.category || "") === activeCategory);
  const q = analysisSearchQuery.trim().toLowerCase();
  if (!q) return byCategory;
  return byCategory.filter((r) =>
    (r.market_name || "").toLowerCase().includes(q),
  );
}

function renderAnalysisFilter() {
  const container = document.getElementById("analysis-filter");
  if (!container) return;
  const all = DATA.tables.market_analysis_schedule || [];
  if (all.length === 0) { container.innerHTML = ""; return; }

  // Build per-category counts. Sections preserve a sensible order:
  // Future Analyses first (forward-looking), then everything else.
  const counts = {};
  all.forEach((r) => {
    const c = r.category || "(uncategorized)";
    counts[c] = (counts[c] || 0) + 1;
  });
  const ordered = Object.keys(counts).sort((a, b) => {
    if (a === "Future Analyses") return -1;
    if (b === "Future Analyses") return 1;
    return a.localeCompare(b);
  });

  // If the currently-active category doesn't exist in the data (e.g. data
  // changed and "Future Analyses" was renamed), fall back to the first one.
  if (!counts[activeCategory] && ordered.length > 0) {
    activeCategory = ordered[0];
  }

  const chips = ordered.map((c) => `
    <button class="chip ${activeCategory === c ? "chip-active" : ""}" data-cat="${escapeHtml(c)}">
      ${escapeHtml(c)} <span class="chip-count">${counts[c]}</span>
    </button>
  `);

  // Search input lives in the same chip row, right-aligned.
  const searchHtml = `
    <div class="filter-search">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/></svg>
      <input type="text" id="analysis-search" placeholder="Search university..." value="${escapeHtml(analysisSearchQuery)}" autocomplete="off">
    </div>
  `;

  container.innerHTML =
    `<span class="filter-label">Section:</span>${chips.join("")}${searchHtml}`;

  container.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeCategory = btn.dataset.cat;
      renderAnalysisFilter();
      renderAnalysis();
    });
  });

  const input = document.getElementById("analysis-search");
  input.addEventListener("input", (e) => {
    analysisSearchQuery = e.target.value;
    renderAnalysis();
  });
  // Keep focus + cursor position across re-renders so typing isn't disrupted
  if (document.activeElement === document.body && analysisSearchQuery) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function fmtDateShort(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function renderAnalysis() {
  const tbody = document.querySelector("#analysis tbody");
  if (!tbody) return;
  const all = DATA.tables.market_analysis_schedule || [];
  const inSection = all.filter((r) => (r.category || "") === activeCategory).length;
  document.getElementById("analysis-count").textContent =
    `Schedule · ${activeCategory} (${inSection} row${inSection === 1 ? "" : "s"})`;

  document.querySelectorAll("#analysis thead th").forEach((th) => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.sort === analysisSortState.col) {
      th.classList.add(analysisSortState.dir === "asc" ? "sorted-asc" : "sorted-desc");
    }
  });

  const rows = analysisRows();
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty-state">No rows match the filter.</td></tr>`;
    return;
  }

  const { col, dir } = analysisSortState;
  const sign = dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const av = a[col] ?? "", bv = b[col] ?? "";
    if (av === "" && bv === "") return 0;
    if (av === "") return 1;
    if (bv === "") return -1;
    return String(av).localeCompare(String(bv), undefined, { numeric: true }) * sign;
  });

  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td class="analysis-section">${escapeHtml(r.category || "—")}</td>
      <td>${escapeHtml(r.market_type || "—")}</td>
      <td class="market-cell">${escapeHtml(r.market_name || "—")}</td>
      <td class="num">${escapeHtml(r.analyst || "—")}</td>
      <td>${escapeHtml(fmtDateShort(r.initial_analysis_date))}</td>
      <td>${escapeHtml(r.initial_decision || "—")}</td>
      <td>${escapeHtml(fmtDateShort(r.ic_date))}</td>
      <td>${escapeHtml(r.ic_decision || "—")}</td>
      <td>${escapeHtml(r.status || "—")}</td>
      <td class="num">${escapeHtml(String(r.est_sites ?? "—"))}</td>
      <td class="notes-cell" title="${escapeHtml(r.notes || "")}">${escapeHtml(r.notes || "—")}</td>
    </tr>
  `).join("");
}

function bindAnalysisSort() {
  document.querySelectorAll("#analysis thead th").forEach((th) => {
    th.addEventListener("click", () => {
      const c = th.dataset.sort;
      if (analysisSortState.col === c) {
        analysisSortState.dir = analysisSortState.dir === "asc" ? "desc" : "asc";
      } else {
        analysisSortState.col = c;
        analysisSortState.dir = "asc";
      }
      renderAnalysis();
    });
  });
}

/* ----- Master render ----------------------------------------- */

function renderAll() {
  const rows = visibleScorecardRows();
  renderIndustryMap();
  renderKpis(rows);
  renderScorecard(rows);
  renderPenetration(rows);
  renderSupply(rows);
  renderDemand(rows);
  renderPricing(rows);
  renderVelocity();
  renderAnalysisFilter();
  renderAnalysis();
}
