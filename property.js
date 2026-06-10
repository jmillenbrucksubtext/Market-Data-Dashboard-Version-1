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
let planSortState = { col: "bedrooms", dir: "asc" };
let activeBedroomFilters = new Set();  // empty Set = show all

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
