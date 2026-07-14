/* Per-chart / per-table "edit" affordance for market.html's Competitive Set,
   Pipeline, and University Information tabs. Adds a small pencil button next
   to the chart-info circled-i on every chart and table. Clicking opens a
   modal listing the data.json rows that feed that visual, with inputs for
   the correctable fields.

   Persistence model (the site is static, refreshed weekly from SQL):
     1. Saving an edit stores it in THIS BROWSER's localStorage in the exact
        entry format of overrides.json, and reloads the page - market.js
        calls SubtextEdit.applyLocal(DATA) right after fetching data.json,
        so every visual that reads the row re-renders with the fix.
     2. The floating "Local edits" pill reviews pending entries and exports
        them (copy / download). Merging them into overrides.json and running
        apply_overrides.py publishes the fix for everyone, permanently -
        export-data.py re-applies overrides.json on every weekly refresh.

   Attachment mirrors chart-info.js: charts via figure.perf-chart, detail
   tables via .comp-table-card, everything else via element id -> nearest
   .card header, re-attached by a debounced MutationObserver after tabs
   lazy-render. */
(function () {
  "use strict";

  var STORE_KEY = "subtext-local-overrides";
  var PIPE_PHASES = { "lease up": 1, "under construction": 1, "planned": 1 };

  var dataRef = null;          // the parsed data.json, set by applyLocal
  var marketKey = Number(new URLSearchParams(location.search).get("id"));

  /* ================= storage ================= */

  function loadStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var doc = raw ? JSON.parse(raw) : null;
      if (doc && doc.v === 1 && Array.isArray(doc.entries)) return doc;
    } catch (e) { /* fall through */ }
    return { v: 1, entries: [] };
  }

  function saveStore(store) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
    catch (e) { alert("Couldn't save edits to localStorage: " + e); }
  }

  function matchKeyOf(entry) {
    var keys = Object.keys(entry.match || {}).sort();
    return entry.table + "|" + keys.map(function (k) {
      return k + "=" + String(entry.match[k]);
    }).join(",");
  }

  /* ================= apply (mirrors apply_overrides.py) ================= */

  function looseEq(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a == null && b == null;
    var fa = Number(a), fb = Number(b);
    if (!isNaN(fa) && !isNaN(fb)) return fa === fb;
    return String(a) === String(b);
  }

  function rowMatches(row, match) {
    for (var k in match) { if (!looseEq(row[k], match[k])) return false; }
    return true;
  }

  function applyLocal(data) {
    dataRef = data;
    var store = loadStore();
    store.entries.forEach(function (entry) {
      entry._matched = 0;
      var table = data.tables && data.tables[entry.table];
      if (!table) return;
      table.forEach(function (row) {
        if (!rowMatches(row, entry.match)) return;
        entry._matched++;
        for (var f in entry.set) row[f] = entry.set[f];
      });
    });
    // keep the _matched flags for the manager panel (not persisted)
    pendingRuntime = store.entries;
  }

  var pendingRuntime = [];

  /* ================= formatting / parsing ================= */

  function fmt(v, type) {
    if (v == null || v === "") return "";
    if (type === "pct") {
      var p = Number(v) * 100;
      return String(Math.round(p * 100) / 100);
    }
    return String(v);
  }

  function parse(s, type) {
    if (type === "str") return s === "" ? null : s;
    var t = String(s).replace(/[$,%\s]/g, "").replace(/,/g, "");
    if (t === "") return null;
    var n = Number(t);
    if (isNaN(n)) return undefined; // signals invalid
    if (type === "pct") return n / 100;
    if (type === "int") return Math.round(n);
    return n;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ================= row helpers ================= */

  function propsOfMarket(d) {
    return d.tables.properties
      .filter(function (p) { return p.market_key === marketKey; })
      .slice()
      .sort(function (a, b) { return String(a.property_name).localeCompare(String(b.property_name)); });
  }

  function propNameMap(d) {
    var m = {};
    d.tables.properties.forEach(function (p) { m[p.property_key] = p.property_name; });
    return m;
  }

  /* ================= section definitions =================
     table   data.json tables.* key (also the overrides.json target)
     match   row fields that identify the row in an override entry
     rows    fn(data) -> rows shown in the editor
     label   fn(row, data) -> identity text for the row
     cols    [{field, sub?, label, type, wide?}] editable fields; sub edits
             one key inside a dict field (whole dict is emitted on save)
     layout  "transposed" = fields as rows, entities as columns (few rows)
  */

  var PROP_COLS = [
    { field: "property_name", label: "Property Name", type: "str", wide: true },
    { field: "phase", label: "Phase", type: "str" },
    { field: "beds", label: "Beds", type: "int" },
    { field: "units", label: "Units", type: "int" },
    { field: "yearBuilt", label: "Year Built", type: "int" },
    { field: "occupancy", label: "Occupancy %", type: "pct" },
    { field: "prelease", label: "Pre-lease %", type: "pct" },
    { field: "avg_rent", label: "Avg Rent/Bed", type: "num" },
    { field: "avg_rent_per_sf", label: "Rent/SF", type: "num" },
    { field: "milesToClosestCampus", label: "Mi to Campus", type: "num" },
    { field: "is_comp_set", label: "Comp Set", type: "bool" },
    { field: "latitude", label: "Latitude", type: "num" },
    { field: "longitude", label: "Longitude", type: "num" }
  ];

  var SEC = {
    properties: {
      table: "properties", match: ["property_key"], cols: PROP_COLS,
      title: "Properties (this market)",
      hint: "Feeds the comp map, comp-set table, pipeline doughnut, new-projects table, and deliveries chart.",
      rows: propsOfMarket,
      label: function (r) { return "#" + r.property_key; }
    },
    propertiesPipeline: {
      table: "properties", match: ["property_key"], cols: PROP_COLS,
      title: "Pipeline-phase properties",
      hint: "Only lease-up / under-construction / planned properties. Phase and beds drive this visual.",
      rows: function (d) {
        return propsOfMarket(d).filter(function (p) {
          return PIPE_PHASES[String(p.phase || "").toLowerCase()];
        });
      },
      label: function (r) { return "#" + r.property_key; }
    },
    propertyHistory: {
      table: "property_history", match: ["property_key", "year_"],
      title: "Property history (per property, per year)",
      hint: "Bed-weighted into the comp-set performance lines and detail tables. Last 6 years shown.",
      cols: [
        { field: "avg_rent_per_bed", label: "Rent/Bed", type: "num" },
        { field: "avg_rent_per_sf", label: "Rent/SF", type: "num" },
        { field: "occupancy", label: "Occupancy %", type: "pct" },
        { field: "prelease", label: "Pre-lease %", type: "pct" },
        { field: "beds", label: "Beds", type: "int" }
      ],
      rows: function (d) {
        var names = propNameMap(d);
        var minYear = new Date().getFullYear() - 6;
        var inMarket = {};
        propsOfMarket(d).forEach(function (p) { inMarket[p.property_key] = 1; });
        return d.tables.property_history
          .filter(function (h) { return inMarket[h.property_key] && h.year_ >= minYear; })
          .slice()
          .sort(function (a, b) {
            var na = String(names[a.property_key]), nb = String(names[b.property_key]);
            return na === nb ? a.year_ - b.year_ : na.localeCompare(nb);
          });
      },
      label: function (r, d) {
        return (propNameMap(d)[r.property_key] || "#" + r.property_key) + " - " + r.year_;
      }
    },
    marketHistory: {
      table: "market_history", match: ["market_key", "year_"],
      title: "Market history (whole-market line)",
      hint: "The dashed market benchmark on the comp-set performance charts.",
      cols: [
        { field: "avg_rent_per_bed", label: "Rent/Bed", type: "num" },
        { field: "occupancy", label: "Occupancy %", type: "pct" },
        { field: "prelease", label: "Pre-lease %", type: "pct" },
        { field: "existing_beds", label: "Existing Beds", type: "int" },
        { field: "beds_lease_up", label: "Lease-up", type: "int" },
        { field: "beds_under_construction", label: "Under Constr.", type: "int" },
        { field: "beds_planned", label: "Planned", type: "int" },
        { field: "beds_pipeline_total", label: "Pipeline Total", type: "int" }
      ],
      rows: function (d) {
        return d.tables.market_history
          .filter(function (h) { return h.market_key === marketKey; })
          .slice()
          .sort(function (a, b) { return a.year_ - b.year_; });
      },
      label: function (r) { return "Year " + r.year_; }
    },
    unitMix: {
      table: "unit_mix", match: ["property_key"],
      title: "Unit & bed mix by property",
      hint: "Totals recompute automatically from the per-type counts. The size / parity / matrix views also draw on floor-plan-level data, so a per-type fix updates the main mix chart first.",
      cols: function (rows) {
        // bedroom types vary by market (Studio, 1BR ... 6BR+) - derive the
        // column set from the rows actually shown
        var seen = {};
        rows.forEach(function (r) {
          Object.keys(r.beds_by_type || {}).forEach(function (t) { seen[t] = 1; });
          Object.keys(r.units_by_type || {}).forEach(function (t) { seen[t] = 1; });
        });
        var types = Object.keys(seen).sort(function (a, b) {
          var na = a === "Studio" ? 0 : parseInt(a, 10) || 99;
          var nb = b === "Studio" ? 0 : parseInt(b, 10) || 99;
          return na - nb;
        });
        var cols = [];
        types.forEach(function (t) {
          cols.push({ field: "beds_by_type", sub: t, label: t + " Beds", type: "int" });
        });
        types.forEach(function (t) {
          cols.push({ field: "units_by_type", sub: t, label: t + " Units", type: "int" });
        });
        return cols;
      },
      rows: function (d) {
        var names = propNameMap(d);
        return d.tables.unit_mix
          .filter(function (u) { return u.market_key === marketKey; })
          .slice()
          .sort(function (a, b) {
            return String(names[a.property_key]).localeCompare(String(names[b.property_key]));
          });
      },
      label: function (r, d) {
        return propNameMap(d)[r.property_key] || "#" + r.property_key;
      }
    },
    universityInfo: {
      table: "university_info", match: ["school_key"], layout: "transposed",
      title: "University info",
      hint: "One column per school in this market. Feeds the profile table, residency pie, statistics grid, KPIs, and the uncaptured-demand chart's on-campus beds.",
      cols: [
        { field: "enrollment_year", label: "Enrollment Year", type: "int" },
        { field: "enrollment_total", label: "Total Enrollment", type: "int" },
        { field: "enr_ft_undergrad", label: "FT Undergrad", type: "int" },
        { field: "enr_pt_undergrad", label: "PT Undergrad", type: "int" },
        { field: "enr_ft_grad", label: "FT Grad", type: "int" },
        { field: "enr_pt_grad", label: "PT Grad", type: "int" },
        { field: "pct_in_state", label: "In-State %", type: "pct" },
        { field: "pct_out_of_state", label: "Out-of-State %", type: "pct" },
        { field: "pct_on_campus", label: "On-Campus %", type: "pct" },
        { field: "pct_off_campus", label: "Off-Campus %", type: "pct" },
        { field: "beds_on_campus_reported", label: "On-Campus Beds (reported)", type: "int" },
        { field: "beds_on_campus_computed", label: "On-Campus Beds (computed)", type: "int" },
        { field: "rate_room_yearly", label: "Room Rate / Yr", type: "num" },
        { field: "rate_board_yearly", label: "Board Rate / Yr", type: "num" },
        { field: "rate_room_monthly", label: "Room Rate / Mo", type: "num" },
        { field: "tuition_in_state", label: "Tuition In-State", type: "num" },
        { field: "tuition_out_of_state", label: "Tuition Out-of-State", type: "num" },
        { field: "credit_hour_in_state", label: "Credit Hour In-State", type: "num" },
        { field: "credit_hour_out_of_state", label: "Credit Hour Out-of-State", type: "num" },
        { field: "applied_first_year", label: "Applied (First-Year)", type: "int" },
        { field: "admitted_first_year", label: "Admitted (First-Year)", type: "int" },
        { field: "admit_rate", label: "Admit Rate %", type: "pct" },
        { field: "enrolled_first_year", label: "Enrolled (First-Year)", type: "int" },
        { field: "student_age_avg", label: "Avg Student Age", type: "num" },
        { field: "parent_income_avg", label: "Parent Income (avg)", type: "num" },
        { field: "parent_income_med", label: "Parent Income (median)", type: "num" }
      ],
      rows: function (d) {
        return d.tables.university_info.filter(function (u) { return u.market_key === marketKey; });
      },
      label: function (r) { return r.short_name || r.university_name; }
    },
    admissionsHistory: {
      table: "admissions_history", match: ["school_key", "year_"],
      title: "Admissions history (dbo.Enrollments)",
      hint: "Applications / admitted / enrolled per year; acceptance and yield are derived.",
      emptyHint: "No admissions_history table in the current data.json - re-run export-data.py.",
      cols: [
        { field: "applications", label: "Applications", type: "int" },
        { field: "admitted", label: "Admitted", type: "int" },
        { field: "enrolled", label: "Enrolled", type: "int" }
      ],
      rows: function (d) {
        var t = d.tables.admissions_history;
        if (!t) return [];
        return t.filter(function (r) { return r.market_key === marketKey; }).slice()
          .sort(function (a, b) { return a.year_ - b.year_; });
      },
      label: function (r) { return (r.university_name || r.ipeds_id || r.school_key) + " - " + r.year_; }
    },
    scorecardDemand: {
      table: "scorecard", match: ["market_key"], layout: "transposed",
      title: "Market scorecard (demand side)",
      hint: "Full-time enrollment is the demand bar of the uncaptured-demand chart.",
      cols: [
        { field: "enr_full_time", label: "FTE Enrollment", type: "int" },
        { field: "existing_beds", label: "Existing PBSH Beds", type: "int" }
      ],
      rows: function (d) {
        return d.tables.scorecard.filter(function (r) { return r.market_key === marketKey; });
      },
      label: function (r) { return r.anchor_university || "This market"; }
    }
  };

  /* ================= visual registry (anchor id -> editor) ================= */

  var REG = {
    /* ---- Competitive Set tab ---- */
    "comp-map-canvas":      { title: "Competitive Set Map", sections: ["properties"] },
    "properties-comps":     { title: "Comp-set Properties", sections: ["properties"] },
    "unitmix-chart":        { title: "Unit & Bed Mix", sections: ["unitMix"] },
    "unitmix-size-chart":   { title: "Unit & Bed Mix", sections: ["unitMix"] },
    "unitmix-pie":          { title: "Unit & Bed Mix", sections: ["unitMix"] },
    "unitmix-parity-pie":   { title: "Unit & Bed Mix", sections: ["unitMix"] },
    "unitmix-summary-table":{ title: "Unit & Bed Mix", sections: ["unitMix"] },
    "unitmix-matrix-table": { title: "Unit & Bed Mix", sections: ["unitMix"] },
    "comp-perf-rent":       { title: "Comp-set Performance", sections: ["propertyHistory", "marketHistory"] },
    "comp-perf-rent-sf":    { title: "Comp-set Performance", sections: ["propertyHistory", "marketHistory"] },
    "comp-perf-occupancy":  { title: "Comp-set Performance", sections: ["propertyHistory", "marketHistory"] },
    "comp-perf-prelease":   { title: "Comp-set Performance", sections: ["propertyHistory", "marketHistory"] },
    "comp-table-rates":       { title: "Comp Detail - Rates", sections: ["propertyHistory"] },
    "comp-table-rent-growth": { title: "Comp Detail - Rent Growth", sections: ["propertyHistory"] },
    "comp-table-prelease":    { title: "Comp Detail - Pre-lease", sections: ["propertyHistory"] },
    "comp-table-occupancy":   { title: "Comp Detail - Occupancy", sections: ["propertyHistory"] },

    /* ---- Pipeline tab ---- */
    "pipe-totalbeds":    { title: "Total Pipeline Beds", sections: ["propertiesPipeline"] },
    "pipe-projects":     { title: "New Projects", sections: ["propertiesPipeline"] },
    "pipe-deliveries":   { title: "Deliveries Over Time", sections: ["properties"] },
    "pipe-supplydemand": { title: "Uncaptured Demand", sections: ["scorecardDemand", "universityInfo", "propertiesPipeline"] },

    /* ---- University Information tab ---- */
    "uni-kpis":            { title: "University KPIs", sections: ["universityInfo", "enrollmentHistory"] },
    "uni-profile-table":   { title: "Undergraduate Student Profile", sections: ["universityInfo"] },
    "uni-residency-pie":   { title: "Undergrad Residency", sections: ["universityInfo"] },
    "uni-admissions-chart":{ title: "Applications, Acceptance & Yield", sections: ["admissionsHistory"] },
    "uni-stats-grid":      { title: "University Statistics", sections: ["universityInfo", "enrollmentHistory"] },
    "enr-chart-fte":       { title: "Enrollment History", sections: ["enrollmentHistory"] },
    "enr-chart-freshman":  { title: "Enrollment History", sections: ["enrollmentHistory"] },
    "enr-chart-total":     { title: "Enrollment History", sections: ["enrollmentHistory"] }
  };

  /* ================= modal ================= */

  var backdrop = null;

  function ensureBackdrop() {
    if (backdrop) return backdrop;
    backdrop = document.createElement("div");
    backdrop.className = "edit-modal-backdrop";
    backdrop.hidden = true;
    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeModal();
    });
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function closeModal() {
    if (backdrop) { backdrop.hidden = true; backdrop.innerHTML = ""; }
  }

  function pendingIndex() {
    var idx = {};
    pendingRuntime.forEach(function (e) { idx[matchKeyOf(e)] = e; });
    return idx;
  }

  function inputFor(row, col, sec) {
    var input;
    var cur = col.sub ? (row[col.field] || {})[col.sub] : row[col.field];
    if (col.type === "bool") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!cur;
      input.defaultChecked = !!cur;
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = fmt(cur, col.type);
      input.defaultValue = input.value;
      if (col.wide || col.type === "str") input.className = "edit-wide";
      input.addEventListener("input", function () {
        input.classList.toggle("is-dirty", input.value !== input.defaultValue);
      });
    }
    input.dataset.field = col.field;
    if (col.sub) input.dataset.sub = col.sub;
    input.dataset.type = col.type;

    // amber ring if a pending local edit already covers this cell
    var entry = pendingIndex()[matchKeyOf({ table: sec.table, match: pickMatch(row, sec) })];
    if (entry && entry.set && Object.prototype.hasOwnProperty.call(entry.set, col.field)) {
      input.classList.add("is-overridden");
      input.title = "Has a pending local edit (see the Local edits pill)";
    }
    return input;
  }

  function pickMatch(row, sec) {
    var m = {};
    sec.match.forEach(function (k) { m[k] = row[k]; });
    return m;
  }

  function buildSection(sec, container) {
    var rows = sec.rows(dataRef);
    var head = document.createElement("div");
    head.className = "edit-modal-sub";
    head.style.margin = "10px 0 6px";
    head.innerHTML = "<strong>" + esc(sec.title) + "</strong>" +
      (sec.hint ? " &middot; " + esc(sec.hint) : "");
    container.appendChild(head);

    if (!rows.length) {
      var none = document.createElement("div");
      none.className = "edit-modal-sub";
      none.textContent = sec.emptyHint || "No rows for this market.";
      container.appendChild(none);
      return null;
    }

    var cols = typeof sec.cols === "function" ? sec.cols(rows) : sec.cols;
    var table = document.createElement("table");
    table.className = "edit-grid";
    table.dataset.secTable = sec.table;

    if (sec.layout === "transposed") {
      // fields as rows, one entity per column
      var thr = document.createElement("tr");
      thr.appendChild(document.createElement("th"));
      rows.forEach(function (r) {
        var th = document.createElement("th");
        th.textContent = sec.label(r, dataRef);
        thr.appendChild(th);
      });
      table.appendChild(thr);
      cols.forEach(function (col) {
        var tr = document.createElement("tr");
        var td0 = document.createElement("td");
        td0.className = "edit-id-cell";
        td0.textContent = col.label;
        tr.appendChild(td0);
        rows.forEach(function (r, ri) {
          var td = document.createElement("td");
          var input = inputFor(r, col, sec);
          input.dataset.rowIdx = ri;
          td.appendChild(input);
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
    } else {
      var thr2 = document.createElement("tr");
      var th0 = document.createElement("th");
      th0.textContent = "Row";
      thr2.appendChild(th0);
      cols.forEach(function (col) {
        var th = document.createElement("th");
        th.textContent = col.label;
        thr2.appendChild(th);
      });
      table.appendChild(thr2);
      rows.forEach(function (r, ri) {
        var tr = document.createElement("tr");
        var td0 = document.createElement("td");
        td0.className = "edit-id-cell";
        td0.textContent = sec.label(r, dataRef);
        tr.appendChild(td0);
        cols.forEach(function (col) {
          var td = document.createElement("td");
          var input = inputFor(r, col, sec);
          input.dataset.rowIdx = ri;
          td.appendChild(input);
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
    }

    container.appendChild(table);
    return { sec: sec, rows: rows, table: table };
  }

  function openEditor(entry) {
    ensureBackdrop();
    backdrop.innerHTML = "";
    var modal = document.createElement("div");
    modal.className = "edit-modal";
    modal.innerHTML =
      '<div class="edit-modal-head">' +
      "<h3>Edit data - " + esc(entry.title) + "</h3>" +
      '<span class="edit-modal-sub">changes preview in this browser; publish via overrides.json</span>' +
      '<button class="edit-modal-close" aria-label="Close">&times;</button>' +
      "</div>" +
      '<div class="edit-modal-body"></div>' +
      '<div class="edit-modal-note">' +
      "<label for=\"edit-note\">Why is the source figure wrong? (saved with the override)</label>" +
      '<input id="edit-note" type="text" placeholder="e.g. CoStar double-counts phase 2 beds">' +
      "</div>" +
      '<div class="edit-modal-foot">' +
      '<span class="edit-modal-hint">Only cells you actually change are saved.</span>' +
      '<button class="edit-btn-secondary" data-act="cancel">Cancel</button>' +
      '<button class="edit-btn-primary" data-act="save">Save &amp; refresh</button>' +
      "</div>";
    backdrop.appendChild(modal);

    var body = modal.querySelector(".edit-modal-body");
    var built = [];
    entry.sections.forEach(function (name) {
      var b = buildSection(SEC[name], body);
      if (b) built.push(b);
    });

    modal.querySelector(".edit-modal-close").addEventListener("click", closeModal);
    modal.querySelector('[data-act="cancel"]').addEventListener("click", closeModal);
    modal.querySelector('[data-act="save"]').addEventListener("click", function () {
      saveEdits(built, modal.querySelector("#edit-note").value.trim());
    });
    backdrop.hidden = false;
  }

  /* ================= saving ================= */

  function saveEdits(built, note) {
    var newEntries = [];
    var invalid = [];

    built.forEach(function (b) {
      var perRow = {}; // rowIdx -> {set fields}, plus dict-sub staging
      b.table.querySelectorAll("input").forEach(function (input) {
        var changed = input.type === "checkbox"
          ? input.checked !== input.defaultChecked
          : input.value !== input.defaultValue;
        if (!changed) return;
        var v;
        if (input.type === "checkbox") v = input.checked;
        else {
          v = parse(input.value, input.dataset.type);
          if (v === undefined) {
            invalid.push(input.dataset.field + " = \"" + input.value + "\"");
            return;
          }
        }
        var ri = input.dataset.rowIdx;
        perRow[ri] = perRow[ri] || { set: {}, subs: {} };
        if (input.dataset.sub) {
          var f = input.dataset.field;
          perRow[ri].subs[f] = perRow[ri].subs[f] || {};
          perRow[ri].subs[f][input.dataset.sub] = v;
        } else {
          perRow[ri].set[input.dataset.field] = v;
        }
      });

      Object.keys(perRow).forEach(function (ri) {
        var row = b.rows[Number(ri)];
        var set = perRow[ri].set;
        // dict-typed fields (unit mix): emit the whole updated dict, then
        // recompute the dependent totals so the visual stays consistent
        Object.keys(perRow[ri].subs).forEach(function (f) {
          var dict = {};
          var current = row[f] || {};
          Object.keys(current).forEach(function (k) { dict[k] = current[k]; });
          Object.keys(perRow[ri].subs[f]).forEach(function (k) {
            var nv = perRow[ri].subs[f][k];
            if (nv == null) delete dict[k]; else dict[k] = nv;
          });
          set[f] = dict;
          var total = 0;
          Object.keys(dict).forEach(function (k) { total += Number(dict[k]) || 0; });
          if (f === "beds_by_type") set.total_beds = total;
          if (f === "units_by_type") set.total_units = total;
        });
        if (!Object.keys(set).length) return;
        newEntries.push({
          table: b.sec.table,
          match: pickMatch(row, b.sec),
          set: set,
          note: note || "edited on the dashboard",
          added: new Date().toISOString().slice(0, 10)
        });
      });
    });

    if (invalid.length) {
      alert("These values aren't numbers - fix or clear them first:\n" + invalid.join("\n"));
      return;
    }
    if (!newEntries.length) { closeModal(); return; }

    // coalesce into the store: same table+match merges its set fields
    var store = loadStore();
    newEntries.forEach(function (ne) {
      var key = matchKeyOf(ne);
      var existing = null;
      store.entries.forEach(function (e) { if (matchKeyOf(e) === key) existing = e; });
      if (existing) {
        for (var f in ne.set) existing.set[f] = ne.set[f];
        if (note) existing.note = note;
      } else {
        store.entries.push(ne);
      }
    });
    saveStore(store);

    // reload on the same tab so every visual re-renders from the edited DATA
    var active = document.querySelector(".market-tab.active");
    if (active) location.hash = active.dataset.tab;
    location.reload();
  }

  /* ================= pending-edits pill + manager ================= */

  var pill = null;

  function ensurePill() {
    if (!pill) {
      pill = document.createElement("button");
      pill.className = "edit-pending-pill";
      pill.type = "button";
      pill.addEventListener("click", openManager);
      document.body.appendChild(pill);
    }
    var n = loadStore().entries.length;
    // only touch the DOM on change - attach() runs from a MutationObserver,
    // so an unconditional rewrite here would loop forever
    var html = "Local edits <span class=\"edit-pill-count\">" + n + "</span>";
    if (pill.hidden !== (n === 0)) pill.hidden = n === 0;
    if (pill.innerHTML !== html) pill.innerHTML = html;
  }

  function describeEntry(e) {
    var match = Object.keys(e.match).map(function (k) { return k + " " + e.match[k]; }).join(", ");
    var sets = Object.keys(e.set).map(function (f) {
      var v = e.set[f];
      return f + " = " + (v !== null && typeof v === "object" ? "{...}" : v);
    }).join(", ");
    return { match: match, sets: sets };
  }

  function openManager() {
    ensureBackdrop();
    backdrop.innerHTML = "";
    var store = loadStore();
    var modal = document.createElement("div");
    modal.className = "edit-modal";
    modal.style.width = "min(760px, 96vw)";
    modal.innerHTML =
      '<div class="edit-modal-head">' +
      "<h3>Local edits</h3>" +
      '<span class="edit-modal-sub">saved in this browser only</span>' +
      '<button class="edit-modal-close" aria-label="Close">&times;</button>' +
      "</div>" +
      '<div class="edit-modal-body">' +
      '<p class="edit-modal-sub" style="margin:0 0 10px">These corrections re-apply on every page load here, but the live site and other users do not see them. To publish for everyone: <strong>Copy JSON</strong>, merge the entries into <code>overrides.json</code> in the repo, run <code>python apply_overrides.py</code>, and push - or hand the JSON to Claude Code and ask it to publish. Once published you can clear them here.</p>' +
      '<ul class="edit-pending-list"></ul>' +
      "</div>" +
      '<div class="edit-modal-foot">' +
      '<span class="edit-modal-hint"></span>' +
      '<button class="edit-btn-secondary" data-act="clear">Clear all</button>' +
      '<button class="edit-btn-secondary" data-act="download">Download</button>' +
      '<button class="edit-btn-primary" data-act="copy">Copy JSON</button>' +
      "</div>";
    backdrop.appendChild(modal);

    var list = modal.querySelector(".edit-pending-list");
    store.entries.forEach(function (e, i) {
      var li = document.createElement("li");
      var d = describeEntry(e);
      var stale = e._matched === 0 || (pendingRuntime[i] && pendingRuntime[i]._matched === 0);
      li.innerHTML =
        '<span class="edit-pending-what"><strong>' + esc(e.table) + "</strong> (" + esc(d.match) + "): " +
        esc(d.sets) + (stale ? ' <span style="color:var(--bad)">- no longer matches a row</span>' : "") + "</span>" +
        '<span class="edit-pending-note">' + esc(e.note || "") + " (" + esc(e.added || "") + ")</span>" +
        '<button class="edit-pending-del" title="Discard this edit" data-i="' + i + '">&times;</button>';
      list.appendChild(li);
    });

    function exportDoc() {
      var clean = store.entries.map(function (e) {
        return { table: e.table, match: e.match, set: e.set, note: e.note, added: e.added };
      });
      return JSON.stringify({ overrides: clean }, null, 2);
    }

    modal.querySelector(".edit-modal-close").addEventListener("click", closeModal);
    modal.querySelector('[data-act="copy"]').addEventListener("click", function () {
      navigator.clipboard.writeText(exportDoc()).then(function () {
        modal.querySelector(".edit-modal-hint").textContent = "Copied - paste into overrides.json's overrides array.";
      }, function () {
        modal.querySelector(".edit-modal-hint").textContent = "Copy failed - use Download instead.";
      });
    });
    modal.querySelector('[data-act="download"]').addEventListener("click", function () {
      var blob = new Blob([exportDoc()], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "local-overrides.json";
      a.click();
      URL.revokeObjectURL(a.href);
    });
    modal.querySelector('[data-act="clear"]').addEventListener("click", function () {
      if (!confirm("Discard all local edits? The page will reload with source data.")) return;
      saveStore({ v: 1, entries: [] });
      location.reload();
    });
    list.querySelectorAll(".edit-pending-del").forEach(function (btn) {
      btn.addEventListener("click", function () {
        store.entries.splice(Number(btn.dataset.i), 1);
        saveStore(store);
        location.reload();
      });
    });
    backdrop.hidden = false;
  }

  /* ================= button mounting (mirrors chart-info.js) ================= */

  var ICON =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M11.1 2.4l2.5 2.5L5.3 13.2l-3 .5.5-3z"/>' +
    '<path d="M9.6 3.9l2.5 2.5"/></svg>';

  function editedTables() {
    var t = {};
    loadStore().entries.forEach(function (e) { t[e.table] = 1; });
    return t;
  }

  function makeBtn(entry) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chart-edit-btn";
    btn.title = "Edit the data behind this visual";
    btn.setAttribute("aria-label", "Edit: " + entry.title);
    btn.innerHTML = ICON;
    var touched = editedTables();
    var hasEdits = entry.sections.some(function (s) { return touched[SEC[s].table]; });
    if (hasEdits) btn.classList.add("has-edits");
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!dataRef) return;
      openEditor(entry);
    });
    return btn;
  }

  function mount(host, entry) {
    if (!host || !entry) return false;
    if (host.querySelector(":scope > .chart-edit-btn")) return true;
    host.appendChild(makeBtn(entry));
    return true;
  }

  function attach() {
    var mounted = {};

    // 1. Charts: figure.perf-chart -> title, keyed by canvas id
    document.querySelectorAll("figure.perf-chart").forEach(function (fig) {
      var canvas = fig.querySelector(".perf-chart-wrap canvas") || fig.querySelector("canvas");
      if (!canvas || !REG[canvas.id]) return;
      if (mount(fig.querySelector(".perf-title-text"), REG[canvas.id])) mounted[canvas.id] = 1;
    });

    // 2. Detail tables: .comp-table-card -> title, keyed by table id
    document.querySelectorAll(".comp-table-card").forEach(function (card) {
      var table = card.querySelector("table[id]");
      if (!table || !REG[table.id]) return;
      if (mount(card.querySelector(".comp-table-title"), REG[table.id])) mounted[table.id] = 1;
    });

    // 3. Everything else: element id -> nearest .card header h2
    Object.keys(REG).forEach(function (id) {
      if (mounted[id]) return;
      var el = document.getElementById(id);
      if (!el) return;
      var card = el.closest(".card");
      if (!card) return;
      mount(card.querySelector(".card-header h2"), REG[id]);
    });

    ensurePill();
  }

  /* ================= boot ================= */

  window.SubtextEdit = { applyLocal: applyLocal };

  var pending = null;
  function schedule() {
    if (pending) return;
    pending = setTimeout(function () { pending = null; attach(); }, 150);
  }
  function start() {
    attach();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
