/* =============================================================
   Student Migration tab
   Two independently normalized origin datasets:
   - in-state CBSA origins sum to 100%
   - out-of-state CBSA origins sum to 100%
   ============================================================= */

let studentMigrationData = null;
let studentMigrationSchool = null;
let studentMigrationLoadPromise = null;
let studentMigrationStates = null;
let studentMigrationBoundary = null;
let studentMigrationInMap = null;
let studentMigrationOutMap = null;
let studentMigrationInOverlay = null;
let studentMigrationOutOverlay = null;

document.addEventListener("DOMContentLoaded", () => {
  const select = document.getElementById("student-migration-school");
  if (!select) return;
  select.addEventListener("change", () => {
    studentMigrationSchool = studentMigrationData?.schools.find(
      (school) => Number(school.ipeds_id) === Number(select.value),
    ) || null;
    renderStudentMigrationSummary();
    renderStudentMigrationRankings();
    renderStudentMigrationMaps();
  });
});

function studentMigrationPct(value, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return "–";
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

async function renderStudentMigrationTab() {
  if (studentMigrationData) {
    setTimeout(() => {
      studentMigrationInMap?.invalidateSize();
      studentMigrationOutMap?.invalidateSize();
    }, 0);
    return;
  }
  if (studentMigrationLoadPromise) return studentMigrationLoadPromise;

  const loading = document.getElementById("student-migration-loading");
  const content = document.getElementById("student-migration-content");
  const empty = document.getElementById("student-migration-empty");
  loading.hidden = false;
  content.hidden = true;
  empty.hidden = true;

  studentMigrationLoadPromise = (async () => {
    try {
      const [migrationResponse, statesResponse, boundaryResponse] = await Promise.all([
        fetch(`assets/student-origin/${MARKET.market_key}.json`, { cache: "no-cache" }),
        fetch("assets/geo/us-states.geojson", { cache: "no-cache" }),
        fetch(`assets/campus-boundaries/${MARKET.market_key}.geojson`, { cache: "no-cache" }),
      ]);
      if (migrationResponse.status === 404) {
        loading.hidden = true;
        empty.hidden = false;
        return;
      }
      if (!migrationResponse.ok) throw new Error(`HTTP ${migrationResponse.status}`);

      const payload = await migrationResponse.json();
      if (Number(payload.market_key) !== Number(MARKET.market_key)) {
        throw new Error("Market key does not match the current dashboard market");
      }
      studentMigrationData = payload;
      studentMigrationStates = statesResponse.ok ? await statesResponse.json() : null;
      studentMigrationBoundary = boundaryResponse.ok ? await boundaryResponse.json() : null;
      studentMigrationSchool =
        payload.schools.find((school) => school.is_anchor) || payload.schools[0] || null;
      if (!studentMigrationSchool) throw new Error("No university records in asset");

      renderStudentMigrationSchoolControl();
      renderStudentMigrationSummary();
      renderStudentMigrationRankings();
      loading.hidden = true;
      content.hidden = false;
      renderStudentMigrationMaps();
    } catch (error) {
      loading.hidden = true;
      empty.hidden = false;
      empty.textContent = `Couldn't load student migration analysis — ${error.message}`;
    } finally {
      studentMigrationLoadPromise = null;
    }
  })();
  return studentMigrationLoadPromise;
}

function renderStudentMigrationSchoolControl() {
  const control = document.getElementById("student-migration-school-control");
  const select = document.getElementById("student-migration-school");
  if (!control || !select || !studentMigrationData) return;
  control.hidden = studentMigrationData.schools.length < 2;
  select.innerHTML = studentMigrationData.schools.map((school) => `
    <option value="${school.ipeds_id}"${school === studentMigrationSchool ? " selected" : ""}>
      ${escapeHtml(school.dashboard_names[0] || school.source_name)}
    </option>`).join("");
}

function renderStudentMigrationSummary() {
  const school = studentMigrationSchool;
  if (!school) return;
  document.getElementById("student-migration-kpi-in-state").textContent =
    studentMigrationPct(school.totals.in_state_share);
  document.getElementById("student-migration-kpi-in-state-sub").textContent =
    `${school.home_state} share of all origins`;
  document.getElementById("student-migration-kpi-out-state").textContent =
    studentMigrationPct(school.totals.out_of_state_share);
  document.getElementById("student-migration-kpi-states").textContent =
    fmtInt(school.totals.origin_states);
  document.getElementById("student-migration-kpi-metros").textContent =
    fmtInt(school.totals.mapped_cbsas);

  const schoolName = school.dashboard_names[0] || school.source_name;
  document.getElementById("student-migration-in-summary").textContent =
    `${schoolName} · ${school.home_state} origins independently normalized to 100%`;
  document.getElementById("student-migration-out-summary").textContent =
    `${schoolName} · non-${school.home_state} origins independently normalized to 100%`;
}

function renderStudentMigrationRankings() {
  const school = studentMigrationSchool;
  if (!school) return;
  renderStudentMigrationRanking(
    "student-migration-in-metros",
    school.points,
    "in_state_group_share",
    "No mapped in-state metro origins.",
  );
  renderStudentMigrationRanking(
    "student-migration-out-metros",
    school.points,
    "out_of_state_group_share",
    "No mapped out-of-state metro origins.",
  );
  renderStudentMigrationStates(school.states);
}

function renderStudentMigrationStates(states) {
  const rows = (states || [])
    .filter((state) => Number(state.share) > 0)
    .sort((a, b) => Number(b.share) - Number(a.share));
  document.getElementById("student-migration-states").innerHTML = rows.length
    ? rows.map((state, index) => `<tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(state.name)}${state.is_home_state ? " (home state)" : ""}</td>
        <td>${studentMigrationPct(state.share, 2)}</td>
      </tr>`).join("")
    : `<tr><td colspan="3">No origin state data.</td></tr>`;
}

function renderStudentMigrationRanking(elementId, points, shareKey, emptyText) {
  const rows = points
    .filter((point) => Number(point[shareKey]) > 0)
    .sort((a, b) => Number(b[shareKey]) - Number(a[shareKey]))
    .slice(0, 15);
  document.getElementById(elementId).innerHTML = rows.length
    ? rows.map((point, index) => `<tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(point.name)}</td>
        <td>${studentMigrationPct(point[shareKey], 2)}</td>
      </tr>`).join("")
    : `<tr><td colspan="3">${escapeHtml(emptyText)}</td></tr>`;
}

function createStudentMigrationMap(elementId) {
  const migrationMap = L.map(elementId, {
    center: [38.5, -97],
    zoom: 4,
    minZoom: 3,
    maxZoom: 19,
    scrollWheelZoom: true,
    worldCopyJump: false,
    maxBounds: [[-5, -180], [75, -45]],
    maxBoundsViscosity: 1,
  });
  const baseLayers = {
    "Street": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
      maxZoom: 19,
      noWrap: true,
    }),
    "Light": L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
      { attribution: "© OSM · © CARTO", subdomains: "abcd", maxZoom: 19, noWrap: true },
    ),
  };
  baseLayers.Light.addTo(migrationMap);
  L.control.layers(baseLayers, null, { position: "topright", collapsed: true })
    .addTo(migrationMap);
  addFullscreenControl(migrationMap);
  return migrationMap;
}

function renderStudentMigrationMaps() {
  const school = studentMigrationSchool;
  if (!school || typeof L === "undefined") return;
  if (!studentMigrationInMap) {
    studentMigrationInMap = createStudentMigrationMap("student-migration-in-map");
    studentMigrationInOverlay = L.layerGroup().addTo(studentMigrationInMap);
  }
  if (!studentMigrationOutMap) {
    studentMigrationOutMap = createStudentMigrationMap("student-migration-out-map");
    studentMigrationOutOverlay = L.layerGroup().addTo(studentMigrationOutMap);
  }
  renderStudentMigrationMap({
    map: studentMigrationInMap,
    overlay: studentMigrationInOverlay,
    group: "in_state",
    shareKey: "in_state_group_share",
    label: "In-state origin distribution",
    legendId: "student-migration-in-legend",
  });
  renderStudentMigrationMap({
    map: studentMigrationOutMap,
    overlay: studentMigrationOutOverlay,
    group: "out_of_state",
    shareKey: "out_of_state_group_share",
    label: "Out-of-state origin distribution",
    legendId: "student-migration-out-legend",
  });
}

function renderStudentMigrationMap({ map, overlay, group, shareKey, label, legendId }) {
  const school = studentMigrationSchool;
  overlay.clearLayers();
  const bounds = L.latLngBounds();
  const points = school.points
    .map((point) => ({ ...point, groupShare: Number(point[shareKey] || 0) }))
    .filter((point) => point.groupShare > 0);
  const sortedShares = points.map((point) => point.groupShare).sort((a, b) => a - b);
  const capIndex = Math.max(0, sortedShares.length - 1);
  const displayCap = sortedShares[capIndex] || 1;
  const intensityExponent = group === "in_state" ? 1.18 : 1.10;
  const heatPoints = points.map((point) => [
    point.lat,
    point.lon,
    Math.min(1, Math.pow(point.groupShare / displayCap, intensityExponent)),
  ]);

  if (studentMigrationStates) {
    const stateByName = new Map(school.states.map((state) => [state.name, state]));
    const stateLayer = L.geoJSON(studentMigrationStates, {
      style: (feature) => {
        const state = stateByName.get(feature.properties.name);
        let share = 0;
        if (state) {
          share = group === "in_state"
            ? Number(state.in_state_group_share || 0)
            : Number(state.out_of_state_group_share || 0);
        }
        return {
          color: "#ffffff",
          weight: 1,
          opacity: 0.8,
          fillColor: studentMigrationStateColor(share),
          fillOpacity: share > 0 ? 0.16 : 0.03,
        };
      },
      onEachFeature: (feature, layer) => {
        const state = stateByName.get(feature.properties.name);
        const share = state
          ? Number(group === "in_state"
            ? state.in_state_group_share
            : state.out_of_state_group_share)
          : 0;
        layer.bindTooltip(
          `<strong>${escapeHtml(feature.properties.name)}</strong><br>` +
          `${studentMigrationPct(share, 2)} of ${group === "in_state" ? "in-state" : "out-of-state"} origins`,
          { sticky: true },
        );
      },
    });
    overlay.addLayer(stateLayer);
  }

  if (typeof L.heatLayer === "function" && points.length) {
    overlay.addLayer(L.heatLayer(
      heatPoints,
      {
        radius: group === "in_state" ? 48 : 40,
        blur: group === "in_state" ? 27 : 25,
        maxZoom: group === "in_state" ? 6 : 5,
        minOpacity: group === "in_state" ? 0.48 : 0.40,
        max: 1,
        gradient: {
          0.08: "#1d4ed8",
          0.25: "#06b6d4",
          0.45: "#84cc16",
          0.65: "#facc15",
          0.82: "#f97316",
          1.0: "#dc2626",
        },
      },
    ));
  }

  points.forEach((point) => {
    bounds.extend([point.lat, point.lon]);
    const matchingStates = point.state_breakdown
      .filter((state) => group === "in_state"
        ? state.abbr === school.home_state
        : state.abbr !== school.home_state)
      .map((state) => {
        const denominator = group === "in_state"
          ? school.totals.in_state
          : school.totals.out_of_state;
        return {
          ...state,
          groupShare: denominator ? state.migrants_in / denominator : 0,
        };
      })
      .sort((a, b) => b.groupShare - a.groupShare);
    const stateRows = matchingStates.slice(0, 4).map((state) => `
      <div class="map-popup-row">
        <span class="map-popup-row-label">${escapeHtml(state.name)}</span>
        <span class="map-popup-row-value">${studentMigrationPct(state.groupShare, 2)}</span>
      </div>`).join("");
    const tooltip = `
      <div class="map-popup">
        <div class="map-popup-head">
          <div class="map-popup-eyebrow">${escapeHtml(label)}</div>
          <div class="map-popup-title">${escapeHtml(point.name)}</div>
        </div>
        <div class="map-popup-body">
          <div class="map-popup-row">
            <span class="map-popup-row-label">Share of this 100% dataset</span>
            <span class="map-popup-row-value">${studentMigrationPct(point.groupShare, 2)}</span>
          </div>
          ${stateRows}
          <div class="map-popup-address">CBSA ${escapeHtml(point.cbsa_id)} · Census 2021 internal point</div>
        </div>
      </div>`;
    const marker = L.circleMarker([point.lat, point.lon], {
      radius: group === "in_state" ? 7 : 5,
      color: C.slate,
      opacity: group === "in_state" ? 0.48 : 0.3,
      fillColor: "#ffffff",
      fillOpacity: group === "in_state" ? 0.14 : 0.08,
      weight: group === "in_state" ? 1.25 : 1,
    }).bindTooltip(tooltip, {
      className: "market-popup-wrapper shadow-market-tooltip student-migration-tooltip",
      direction: "auto",
      offset: [10, 0],
      opacity: 1,
    });
    marker.on("mouseover", () => positionStudentMigrationTooltip(map, marker));
    overlay.addLayer(marker);
  });

  if (studentMigrationBoundary) {
    const boundaryLayer = L.geoJSON(studentMigrationBoundary, {
      style: {
        color: "#d32f2f",
        weight: 2,
        opacity: 0.95,
        fillColor: "#d32f2f",
        fillOpacity: 0.15,
      },
      interactive: false,
    });
    overlay.addLayer(boundaryLayer);
    bounds.extend(boundaryLayer.getBounds());
  }
  school.campuses.forEach((campus) => {
    bounds.extend([campus.lat, campus.lon]);
    overlay.addLayer(L.marker([campus.lat, campus.lon], {
      icon: campusMarkerIcon(true, MARKET.market_key, campus.name),
      zIndexOffset: 1000,
    }).bindPopup(`<div class="map-popup">
      <div class="map-popup-head">
        <div class="map-popup-eyebrow">Selected university</div>
        <div class="map-popup-title">${escapeHtml(campus.name)}</div>
      </div>
    </div>`));
  });

  if (bounds.isValid()) {
    map.fitBounds(bounds, {
      padding: [24, 24],
      maxZoom: group === "in_state" ? 6 : 5,
    });
  }
  const unlocatedCount = group === "in_state"
    ? school.totals.unlocated_in_state
    : school.totals.unlocated_out_of_state;
  const denominator = group === "in_state"
    ? school.totals.in_state
    : school.totals.out_of_state;
  const unlocatedShare = denominator ? unlocatedCount / denominator : 0;
  const mappedShare = Math.max(0, 1 - unlocatedShare);
  document.getElementById(legendId).innerHTML = `
    <strong>Dataset total:</strong> 100.00% ·
    <strong>Mapped to CBSA centroids:</strong> ${studentMigrationPct(mappedShare, 2)} ·
    <strong>Unlocated:</strong> ${studentMigrationPct(unlocatedShare, 2)}<br>
    <strong>Heat:</strong> Lower share <span class="student-migration-gradient"></span> Higher share.
    Each metro is weighted by its percentage of this dataset. The strongest metro
    (${studentMigrationPct(displayCap, 2)}) anchors the scale, and zoom-aware contrast
    keeps major population centers dominant when the map is viewed nationally.
  `;
  setTimeout(() => map.invalidateSize(), 0);
}

function studentMigrationStateColor(share) {
  if (share >= 0.5) return "#55426f";
  if (share >= 0.2) return "#6f5b8b";
  if (share >= 0.08) return "#8b79a5";
  if (share >= 0.03) return "#aa9abc";
  if (share > 0) return "#c9bfd3";
  return "#e7e3dc";
}

function positionStudentMigrationTooltip(map, layer) {
  const tooltip = layer.getTooltip();
  if (!tooltip) return;
  const point = map.latLngToContainerPoint(layer.getLatLng());
  const mapSize = map.getSize();
  const verticalGuard = 175;
  let direction;
  if (point.y < verticalGuard) direction = "bottom";
  else if (point.y > mapSize.y - verticalGuard) direction = "top";
  else direction = point.x < mapSize.x / 2 ? "right" : "left";
  tooltip.options.direction = direction;
  tooltip.options.offset = L.point(
    direction === "top" || direction === "bottom" ? 0 : 10,
    direction === "top" || direction === "bottom" ? 10 : 0,
  );
  tooltip.update();
  requestAnimationFrame(() => {
    const element = tooltip.getElement();
    if (!element) return;
    const mapRect = map.getContainer().getBoundingClientRect();
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
      const position = L.DomUtil.getPosition(element);
      if (position) L.DomUtil.setPosition(element, position.add(L.point(dx, dy)));
    }
  });
}
