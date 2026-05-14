/* =============================================================
   Subtext Living — Market Detail page
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
let propSortState = { col: "prelease", dir: "desc" };
let map = null;
let propertyMarkers = new Map();  // property_key → leaflet marker

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
    return showError(`Couldn't load data.json — ${err}`);
  }

  // Optional: load campus logo manifest. Missing manifest is fine — every
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

  // Wait for Leaflet to load (deferred script)
  if (typeof L === "undefined") {
    await new Promise((r) => window.addEventListener("load", r, { once: true }));
  }
  renderMap();
});

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
function fmtNum(v, digits = 1) {
  if (v == null || isNaN(v)) return "—";
  return Number(v).toFixed(digits);
}
function fmtYear(v) {
  if (v == null || isNaN(v) || v < 1800) return "—";
  return String(v);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function deltaSpan(v) {
  if (v == null) return `<span class="delta flat">—</span>`;
  const cls = v > 0.005 ? "up" : v < -0.005 ? "down" : "flat";
  const arr = v > 0.005 ? "▲" : v < -0.005 ? "▼" : "";
  return `<span class="delta ${cls}"><span class="arrow">${arr}</span>${fmtPct(v)}</span>`;
}

/* ----- Header + KPIs ----------------------------------------- */

function renderHeader() {
  document.getElementById("market-name").textContent = MARKET.anchor_university;
  const region = MARKET.region ? ` · ${MARKET.region}` : "";
  document.getElementById("market-subtitle").textContent =
    `${MARKET.city || ""}, ${MARKET.state_abbr || ""}${region}`;

  document.title = `${MARKET.anchor_university} — Subtext`;

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
  document.getElementById("kpi-pipeline-sub").textContent = pipParts.join(" · ") || "—";

  document.getElementById("kpi-pen").textContent = fmtPct(MARKET.penetration_ratio);
  const bandColor = MARKET.penetration_ratio == null ? C.slate70
    : MARKET.penetration_ratio < 0.30 ? C.good
    : MARKET.penetration_ratio > 0.55 ? C.bad
    : C.warn;
  document.getElementById("kpi-pen").style.color = bandColor;
  const band = MARKET.penetration_ratio == null ? "—"
    : MARKET.penetration_ratio < 0.30 ? "Under-supplied"
    : MARKET.penetration_ratio > 0.55 ? "Over-supplied"
    : "Balanced";
  document.getElementById("kpi-pen-sub").textContent = band;

  document.getElementById("kpi-enr").textContent = fmtInt(MARKET.total_enrollment);
  document.getElementById("kpi-enr-sub").textContent =
    CAMPUSES.length > 0 ? `${CAMPUSES.length} ${CAMPUSES.length === 1 ? "university" : "universities"}` : "—";

  document.getElementById("kpi-rent").textContent = fmtUsd(MARKET.avg_rent_per_bed);
  document.getElementById("kpi-rent-sub").textContent = "bed-weighted average";

  // Rent YoY — pull from rent_yoy table; render in big KPI style with color
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
    yoyEl.textContent = "—";
    document.getElementById("kpi-rent-yoy-sub").textContent = "no prior-year data";
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
    badgeEl.textContent = "—";
    return;
  }

  const pct = q.score_pct == null ? null : Math.round(q.score_pct * 100);
  badgeEl.textContent = pct == null ? "—" : `${pct}%`;
  badgeEl.dataset.tier =
    pct == null ? "na" : pct >= 80 ? "good" : pct >= 60 ? "warn" : "bad";

  const naCount = q.results.filter((r) => r.status === "na").length;
  summaryEl.textContent =
    `${q.passes} of ${q.evaluable} evaluable qualifiers passing` +
    (naCount > 0 ? ` · ${naCount} pending data` : "");

  listEl.innerHTML = q.results.map((r) => {
    const tier = r.tier || r.status;  // backwards compat
    return `
      <li class="qual-row qual-${tier}">
        <div class="qual-label">${escapeHtml(r.label)}</div>
        <div class="qual-actual qual-actual-${tier}">${escapeHtml(r.actual_display)}</div>
      </li>`;
  }).join("");
}

/* ----- Properties table -------------------------------------- */

function bindPropertySort() {
  document.querySelectorAll("#properties thead th").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      if (propSortState.col === col) {
        propSortState.dir = propSortState.dir === "asc" ? "desc" : "asc";
      } else {
        propSortState.col = col;
        propSortState.dir = th.dataset.type === "num" ? "desc" : "asc";
      }
      renderProperties();
    });
  });
}

function renderProperties() {
  const tbody = document.querySelector("#properties tbody");
  document.querySelectorAll("#properties thead th").forEach((th) => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.sort === propSortState.col) {
      th.classList.add(propSortState.dir === "asc" ? "sorted-asc" : "sorted-desc");
    }
  });

  if (PROPERTIES.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty-state">
      No purpose-built properties listed for this market.</td></tr>`;
    document.getElementById("prop-count").textContent = "0 properties";
    return;
  }

  const { col, dir } = propSortState;
  const sign = dir === "asc" ? 1 : -1;
  const rows = PROPERTIES.slice().sort((a, b) => {
    const av = a[col], bv = b[col];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number") return (av - bv) * sign;
    if (typeof av === "boolean") return (Number(av) - Number(bv)) * sign;
    return String(av).localeCompare(String(bv)) * sign;
  });

  tbody.innerHTML = rows.map((p) => `
    <tr data-pk="${p.property_key}">
      <td class="property-cell">
        ${escapeHtml(p.property_name || "(unnamed)")}
        <span class="city-state">${escapeHtml(p.street1 || "")}</span>
      </td>
      <td>${phasePill(p.phase)}</td>
      <td class="num">${fmtInt(p.beds)}</td>
      <td class="num">${fmtYear(p.yearBuilt)}</td>
      <td class="num">${fmtPct(p.occupancy)}</td>
      <td class="num">${fmtPct(p.prelease)}</td>
      <td class="num">${fmtUsd(p.avg_rent)}</td>
      <td class="num">${p.avg_rent_per_sf != null ? "$" + fmtNum(p.avg_rent_per_sf, 2) : "—"}</td>
      <td>${p.hasConcessions ? '<span class="band-pill band-Balanced">Yes</span>' : '<span class="delta flat">—</span>'}</td>
      <td class="num">${fmtNum(p.milesToClosestCampus, 1)}</td>
      <td class="num">${p.currentGoogleReviewAvg != null ? fmtNum(p.currentGoogleReviewAvg, 1) : "—"}</td>
    </tr>
  `).join("");

  // Row click → property detail page.
  // Shift-click keeps the previous behavior: pan + highlight in place.
  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      const pk = Number(tr.dataset.pk);
      if (e.shiftKey) {
        const marker = propertyMarkers.get(pk);
        if (marker && map) {
          map.setView(marker.getLatLng(), Math.max(map.getZoom(), 13), { animate: true });
          marker.openPopup();
        }
        document.querySelectorAll("#properties tr.selected").forEach((r) => r.classList.remove("selected"));
        tr.classList.add("selected");
        return;
      }
      window.location.href = `property.html?id=${pk}`;
    });
  });

  document.getElementById("prop-count").textContent =
    `${rows.length} purpose-built propert${rows.length === 1 ? "y" : "ies"}`;
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
  if (!phase) return `<span class="phase-pill phase-unknown">—</span>`;
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
  if (typeof L === "undefined") {
    document.getElementById("map").innerHTML =
      `<div class="empty-state">Map library failed to load.</div>`;
    return;
  }

  // Collect everything that has lat/long
  const propsWithCoords = PROPERTIES.filter(
    (p) => p.latitude != null && p.longitude != null,
  );
  const allCampuses = CAMPUSES.filter(
    (c) => c.campus_lat != null && c.campus_lng != null,
  );

  if (propsWithCoords.length === 0 && allCampuses.length === 0) {
    document.getElementById("map").innerHTML =
      `<div class="empty-state">No geocoded properties or campuses for this market.</div>`;
    return;
  }

  // Anchor university = the school whose name matches MARKET.anchor_university
  const anchor = allCampuses.find((c) => c.university_name === MARKET.anchor_university)
              || allCampuses[0];
  const startLat = anchor ? anchor.campus_lat : propsWithCoords[0].latitude;
  const startLng = anchor ? anchor.campus_lng : propsWithCoords[0].longitude;

  map = L.map("map", {
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
  // Default to Satellite for visual richness
  baseLayers.Satellite.addTo(map);
  L.control.layers(baseLayers, null, { position: "topright", collapsed: true }).addTo(map);
  addFullscreenControl(map);

  // Bounds collector for auto-fit
  const allLatLngs = [];

  // Campus boundary polygon (red shaded outline, like the reference screenshot).
  // Loads if the GeoJSON file exists for this market_key; silent otherwise.
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
      }).addTo(map);
      // Include the polygon in the auto-fit bounds
      const b = layer.getBounds();
      if (b.isValid()) {
        allLatLngs.push([b.getNorth(), b.getEast()]);
        allLatLngs.push([b.getSouth(), b.getWest()]);
      }
    }
  } catch { /* missing boundary file is fine */ }

  // Campus markers
  allCampuses.forEach((c) => {
    const isAnchor = c.university_name === MARKET.anchor_university;
    const m = L.marker([c.campus_lat, c.campus_lng], {
      icon: campusMarkerIcon(isAnchor, MARKET.market_key),
      zIndexOffset: isAnchor ? 1000 : 500,
    }).addTo(map);
    m.bindPopup(`
      <strong>${escapeHtml(c.university_name)}</strong><br>
      Enrollment: ${fmtInt(c.total_enrollment)} (${c.enrollment_year || "—"})
      ${isAnchor ? '<br><em>Anchor university</em>' : ""}
    `);
    allLatLngs.push([c.campus_lat, c.campus_lng]);
  });

  // Property markers
  propsWithCoords.forEach((p) => {
    const m = L.marker([p.latitude, p.longitude], {
      icon: propMarkerIcon(p),
    }).addTo(map);
    m.bindPopup(`
      <strong>${escapeHtml(p.property_name || "(unnamed)")}</strong><br>
      ${escapeHtml(p.street1 || "")}<br>
      Beds: ${fmtInt(p.beds)} · Built ${fmtYear(p.yearBuilt)}<br>
      Occupancy: ${fmtPct(p.occupancy)} · Pre-lease: ${fmtPct(p.prelease)}<br>
      Avg rent: ${fmtUsd(p.avg_rent)} · ${fmtNum(p.milesToClosestCampus, 1)} mi to campus<br>
      <a href="property.html?id=${p.property_key}" class="popup-link">View floor plans →</a>
    `);
    propertyMarkers.set(p.property_key, m);
    allLatLngs.push([p.latitude, p.longitude]);
  });

  // Auto-fit to bounds (or stay zoomed on anchor if just one point)
  if (allLatLngs.length > 1) {
    map.fitBounds(allLatLngs, { padding: [40, 40], maxZoom: 14 });
  }
}
