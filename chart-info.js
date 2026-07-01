/* Per-chart / per-table "info" affordance. Adds a small circled-i button next
   to the title of every chart, table, map, and KPI tile across the Industry,
   Market, and Property pages. Clicking opens a popover that explains the
   metric's formula, its data.json / SQL source field, and why it matters.

   Content is lifted verbatim from dictionary.html so the two never drift -
   this file is the inline, in-context version of that reference page.

   Attaches purely by walking the existing DOM (no HTML edits needed), mirroring
   chart-download.js: charts are found via figure.perf-chart, detail tables via
   .comp-table-card, everything else via a known element id -> nearest card
   header. A debounced MutationObserver re-attaches after tabs lazy-render or a
   dynamic title is rewritten. */
(function () {
  "use strict";

  /* ---- the circled-i icon (stroke-based, matches the nav + download icons) -- */
  var ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
    '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.1v3.7"/>' +
    '<circle cx="8" cy="4.7" r="0.45" fill="currentColor" stroke="none"/></svg>';

  /* ---- content registry ---------------------------------------------------
     key            stable DOM id (canvas / table) or - for KPI tiles - the
                    normalised tile label.
     title          popover heading.
     formula        how the number is computed.
     sql            the data.json table / SQL column it traces back to.
     sig            why it matters / how to read it.
     rows           optional [label, detail] pairs for per-column / per-series
                    breakdowns. Backticks render as <code>. */
  var REG = {

    /* ================= INDUSTRY PAGE (index.html) ================= */
    "industry-map": {
      title: "Industry map",
      formula: "One pin per market, placed at the anchor university. With `Active markets` on (default) pins are coloured by pipeline stage (Pursuing green, Assessing amber, Upcoming slate); with it off pins revert to the qualifier-score tier (>= 80% green, 60-79% amber, < 60% rust, NA grey). Subtext-30 markets get a larger pin with a lime ring.",
      sql: "`scorecard` <- dbo.MarketReports + dbo.Markets (latest snapshot): anchor_university, city, state_abbr, qualifier_score, existing_beds, is_subtext30, market_status",
      sig: "A geographic read of where every tracked market sits. `Active markets` shows Subtext's pipeline board (Upcoming / Assessing / Pursuing) categorised by stage; the other toggles filter to the Subtext-30 list or the Power-4 conference markets."
    },
    "scorecard": {
      title: "Market scorecard",
      formula: "Active-pipeline markets grouped into a table per CRM stage (Upcoming / Assessing / Pursuing), a monthly-market-update layout. Markets sort A-Z within each stage; click one to open it.",
      sql: "`scorecard` (joined to fte_history, rent_yoy, university_info, properties) where market_status is set",
      sig: "Every market Subtext is actively tracking, broken out by pipeline stage.",
      rows: [
        ["FTE / FTE Growth", "Full-time enrollment and its YoY change (`fte_history.yoy_fte_growth`)"],
        ["Market Occ. / Prelease", "`MarketReports.occupancy` / `prelease` at the latest snapshot"],
        ["Market Rent", "Bed-weighted `avg_rent` across the market"],
        ["Rent - 0.5 / 1.0 Mile", "Bed-weighted `avg_rent` of properties within that radius of campus"],
        ["YoY Rent Growth", "`rent_yoy.yoy_rent_growth`"],
        ["On-Campus Beds", "Sum of on-campus beds across the market's universities"],
        ["PBSH Beds", "Existing purpose-built student-housing beds (`existing_beds`)"],
        ["UD as FTE %", "Uncaptured demand: `1 - existing_beds / enr_full_time`"]
      ]
    },
    "supply-chart": {
      title: "Supply: Existing + Pipeline",
      formula: "Stacked horizontal bars, top 30 markets by total beds: `existing + lease-up + under-construction + planned`.",
      sql: "`scorecard`: existing_beds, beds_lease_up, beds_under_construction, beds_planned",
      sig: "Ranks markets by total bed supply and shows how much is already delivered versus still in the pipeline."
    },
    "demand-chart": {
      title: "Enrollment Growth",
      formula: "5-year enrollment CAGR, top 30 markets by enrollment: `(enr_end / enr_start)^(1/5) - 1`.",
      sql: "`scorecard.cagr_5yr` (derived from MarketReports.enr_full_time history)",
      sig: "Demand-side momentum - which markets are growing their student base fastest."
    },
    "pricing-rent-chart": {
      title: "Avg Rent per Bed",
      formula: "Bed-weighted average rent per bed, top 30. Bars coloured by Subtext-30 membership.",
      sql: "`scorecard.avg_rent_per_bed` <- MarketReports.rate_avg (latest snapshot)",
      sig: "Where each market sits on absolute rent level."
    },
    "pricing-growth-chart": {
      title: "Rent YoY Growth",
      formula: "Year-over-year rent growth, top 30: `(rent_t - rent_{t-1}) / rent_{t-1}`.",
      sql: "`scorecard.yoy_rent_growth` (from market_history.avg_rent_per_bed)",
      sig: "Rent momentum - which markets are pushing rate hardest."
    },
    "analysis": {
      title: "Market Analysis Schedule",
      formula: "Internal pipeline tracker - one row per scheduled market: analyst, initial analysis + decision, IC date + decision, status, estimated sites.",
      sql: "`market_analysis_schedule` <- Market Analysis Schedule.xlsx (OneDrive), read by export-data.py at refresh time",
      sig: "Reflects the state of the schedule spreadsheet at the last Monday 06:00 refresh."
    },

    /* ================= MARKET PAGE (market.html) ================= */
    "qualifier-list": {
      title: "Subtext Qualifier Scorecard",
      formula: "13 pass/fail rules. Per-market score = `sum(credit_fraction) / count(evaluable)`; multi-year qualifiers earn partial credit. Tier: >= 80% green, 60-80% amber, < 60% red.",
      sql: "`market_qualifiers` - computed by compute_qualifiers + the patcher family from scorecard, market_history, fte_history, prelease_velocity, properties, and market_affluence",
      sig: "The Subtext underwriting screen for the market.",
      rows: [
        ["Nominal market rent > $900", "`scorecard.avg_rent_per_bed > 900` (MarketReports.rate_avg)"],
        ["Comp-set rent > $1,000", "Bed-weighted avg `avg_rent` across the comp-set > 1000"],
        ["FTE enrollment > 15,000", "`enr_full_time > 15000`"],
        ["Market occupancy > 90%", "`occupancy > 0.90`"],
        ["FTE growth since 2022 > 3%", "`(current_fte - baseline_2022_fte) / baseline_2022_fte > 0.03`"],
        ["FTE growth YoY positive", "`(current_fte - prior_fte) / prior_fte > 0`; prior = most recent snapshot whose FTE differs from current (not literal T-1yr)"],
        ["Rent growth >= 3% trailing 3 yrs", "All three trailing YoY rates >= 3%; each year is 1/3 partial credit"],
        ["Prelease not lagging prior yr by > 5%", "Same-week-of-cycle delta vs prior cycle >= -0.05"],
        ["Pipeline <= 10% of existing supply", "`beds_pipeline_total / existing_beds <= 0.10`"],
        ["Uncaptured demand within 1 mi > 30%", "`1 - (sum beds in PBSH within 1 mi) / enr_full_time > 0.30`"],
        ["Avg income of median zips > $85K", "`mean_origin_income > 85000`"],
        ["Power 4 or R1 university", "Anchor is a Power-4 member or a Carnegie 2025 R1; city-only markets are NA"],
        ["Subtext Top 50 forward market", "Forward-model rank <= 50; markets absent from the model are NA"]
      ]
    },
    "map": {
      /* shared id - used by the Market Map (market.html) and Location (property.html) */
      title: "Map",
      formula: "Leaflet map: campus boundary polygon, the anchor university pin, and all purpose-built properties pinned by phase. Click a pin for property stats.",
      sql: "`properties` (dbo.Properties, purpose-built non-shadow): latitude, longitude, phase, property_key; `campus_locations`: campus_lat / campus_lng",
      sig: "The spatial layout of supply around campus."
    },
    "perf-rent": {
      title: "Market Rent",
      formula: "Bed-weighted average rent per bed at anchored annual snapshots. Solid rust line = this market; dashed everest line = bed-weighted Subtext-30 average at the same anchor.",
      sql: "`market_history.avg_rent_per_bed` <- dbo.MarketReports (anchored annual snapshots, 2020+)",
      sig: "Rent level trend versus the Subtext-30 benchmark."
    },
    "perf-rent-growth": {
      title: "Market Rent Growth",
      formula: "`(rent_t - rent_{t-1}) / rent_{t-1}` per anchored year.",
      sql: "`market_history.avg_rent_per_bed`",
      sig: "Year-over-year rent momentum for the market."
    },
    "perf-occupancy": {
      title: "Market Occupancy",
      formula: "Physical occupancy at each anchored annual snapshot.",
      sql: "`market_history.occupancy` <- dbo.MarketReports",
      sig: "Whether the market is filling its beds."
    },
    "perf-prelease": {
      title: "Market Pre-lease",
      formula: "Pre-lease percentage at each anchored annual snapshot.",
      sql: "`market_history.prelease` <- dbo.MarketReports",
      sig: "Leasing pace - how far ahead of move-in the market is committed."
    },
    "properties-all": {
      title: "Market Properties",
      formula: "Every purpose-built property in the market. Sortable; click a row to drill to the property page, shift-click to highlight on the map.",
      sql: "`properties` (dbo.Properties + plan aggregates): property_name, phase, beds, yearBuilt, occupancy, prelease, avg_rent, avg_rent_per_sf, milesToClosestCampus",
      sig: "The full property inventory underlying every market metric."
    },
    "comp-map-canvas": {
      title: "Competitive Set Map",
      formula: "Static map of comp-set members only (see the comp-set rule below).",
      sql: "`properties` filtered by `is_comp_set`",
      sig: "The competitive set Subtext benchmarks the market against."
    },
    "properties-comps": {
      title: "Comp-set Properties",
      formula: "One row per comp-set member with a checkbox; the charts and tables below recompute live whenever the selection changes.",
      sql: "`properties` where is_comp_set. Rule: phase = stable (stabilized only) AND milesToClosestCampus <= 1.0 AND beds >= 150 AND (yearBuilt >= 2020 OR top 5 by avg_rent)",
      sig: "The selectable comp set that drives all Competitive Set analytics."
    },
    "unitmix-chart": {
      title: "Inventory by Bedroom Type",
      formula: "Stacked bars of beds (or units) by bedroom type (Studio through 6BR+) across selected comps.",
      sql: "`unit_mix.beds_by_type` / `units_by_type` aggregated from plans/*.json. Beds are authoritative; units are derived (beds / bedrooms)",
      sig: "Product mix of the competitive set by bedroom count."
    },
    "unitmix-size-chart": {
      title: "Average Unit Size by Unit Type",
      formula: "Bed-weighted average square feet by unit type across selected comps.",
      sql: "`unit_mix.size_by_unit.avg_sf` (from plans)",
      sig: "Typical unit footprint by bedroom type."
    },
    "unitmix-pie": {
      title: "Unit Mix by Building",
      formula: "Nested doughnut - inner ring: bedroom type; outer ring: bath parity (lighter = shared bath).",
      sql: "`unit_mix.beds_by_type` / `units_by_type` for the selected building",
      sig: "Single-building product breakdown."
    },
    "unitmix-parity-pie": {
      title: "Bed / Bath Parity",
      formula: "Share of beds (or units) with a private bath (full parity) versus a shared bath (partial).",
      sql: "`unit_mix.parity_by_type` beds_full / beds_partial (or units_full / units_partial)",
      sig: "Bed-to-bath parity, a key amenity and pricing driver."
    },
    "unitmix-summary-table": {
      title: "Unit Mix - Market Summary",
      formula: "Beds and units by bedroom type with percent of total across selected comps.",
      sql: "`unit_mix.beds_by_type` / `units_by_type` aggregated",
      sig: "Tabular version of the inventory-by-type chart."
    },
    "unitmix-matrix-table": {
      title: "Unit Mix - By Property",
      formula: "Matrix: one row per property, columns are bed / unit counts per bedroom type.",
      sql: "`unit_mix` per property",
      sig: "Per-property breakdown of the unit mix."
    },
    "comp-perf-rent": {
      title: "Comp-set Avg Rent / Bed",
      formula: "Bed-weighted aggregate across selected comps: `sum(value x beds) / sum(beds)`. Solid rust = comps aggregate; dashed everest = market.",
      sql: "comps: `property_history.avg_rent_per_bed` (dbo.PlanReports, bed-weighted anchored) | market: `market_history.avg_rent_per_bed`",
      sig: "Comp-set rent level versus the whole market."
    },
    "comp-perf-rent-sf": {
      title: "Comp-set Rent / SF",
      formula: "Bed-weighted aggregate `sum(value x beds) / sum(beds)`. Solid rust = comps; dashed everest = market.",
      sql: "comps: `property_history.avg_rent_per_sf` | market: same field from market_history",
      sig: "Rent efficiency per square foot - normalises for unit size."
    },
    "comp-perf-occupancy": {
      title: "Comp-set Occupancy",
      formula: "Bed-weighted aggregate `sum(value x beds) / sum(beds)`. Solid rust = comps; dashed everest = market.",
      sql: "comps: `property_history.occupancy` | market: `market_history.occupancy`",
      sig: "How full the comp set runs versus the market."
    },
    "comp-perf-prelease": {
      title: "Comp-set Pre-lease",
      formula: "Bed-weighted aggregate `sum(value x beds) / sum(beds)`. Solid rust = comps; dashed everest = market.",
      sql: "comps: `property_history.prelease` | market: `market_history.prelease`",
      sig: "Comp-set leasing pace versus the market."
    },
    "comp-table-rates": {
      title: "Comp Rates (annual)",
      formula: "Body: `property_history.avg_rent_per_bed` by year, one row per comp. Footer: bed-weighted avg rent, then YoY / 2-Yr / 3-Yr cumulative growth.",
      sql: "`property_history.avg_rent_per_bed`",
      sig: "Year-by-year comp rent detail. Footer growth is cumulative versus N years prior, not annualised: 2-Yr 2025 = (2025 - 2023) / 2023."
    },
    "comp-table-rent-growth": {
      title: "Comp Rent Growth (YoY)",
      formula: "Per-property YoY `(rent_t - rent_{t-1}) / rent_{t-1}`. Footer: average growth (mean of per-property growths).",
      sql: "`property_history.avg_rent_per_bed`",
      sig: "How hard each comp is pushing rate, year over year."
    },
    "comp-table-prelease": {
      title: "Comp Pre-lease (anchor month)",
      formula: "Body: `property_history.prelease` by year. Footer: bed-weighted average pre-lease, then YoY / 2-Yr growth.",
      sql: "`property_history.prelease`",
      sig: "Comp leasing pace at the anchor month, year over year."
    },
    "comp-table-occupancy": {
      title: "Comp Occupancy (anchor month)",
      formula: "Body: `property_history.occupancy` by year. Footer: bed-weighted average occupancy, then YoY / 2-Yr growth.",
      sql: "`property_history.occupancy`",
      sig: "Comp occupancy at the anchor month, year over year."
    },
    "pipe-totalbeds": {
      title: "Total Pipeline Beds",
      formula: "Doughnut of forward-supply beds split by phase: lease-up + under-construction + planned.",
      sql: "`properties` phase bed counts (per-property, not the market pipeline_beds field)",
      sig: "Composition of the forward supply pipeline."
    },
    "pipe-projects": {
      title: "New Projects",
      formula: "One row per pipeline-phase property: name, phase, year built, beds.",
      sql: "`properties` filtered to lease_up / under_construction / planned phases",
      sig: "The specific deals that make up the pipeline."
    },
    "pipe-deliveries": {
      title: "Deliveries Over Time",
      formula: "Stacked bars of beds by year built: delivered (stable / lease-up) versus projected (under-construction / planned).",
      sql: "`properties` beds grouped by yearBuilt and phase",
      sig: "The delivery timeline of new supply. Hover a year to see which properties delivered and the beds each contributed."
    },
    "pipe-supplydemand": {
      title: "Uncaptured Demand",
      formula: "Horizontal stack of FTE demand met by on-campus + existing + pipeline beds; the remainder is uncaptured demand.",
      sql: "`properties` beds by phase + on-campus beds + MarketReports.enr_full_time",
      sig: "How much student demand is still unmet by purpose-built supply."
    },
    "student-migration-in-map": {
      title: "In-State Origin Heatmap",
      formula: "`in-state CBSA MigrantsIn / total in-state MigrantsIn`, normalised to 100% independently of the in/out-of-state mix.",
      sql: "assets/student-origin/<market>.json (MigrationOnly source, matched on UNIQUEID = ipeds_id)",
      sig: "Where in-state students come from. Heat is relative origin share, not a precise address."
    },
    "student-migration-out-map": {
      title: "Out-of-State Origin Heatmap",
      formula: "`out-of-state CBSA MigrantsIn / total out-of-state MigrantsIn` - a second independent 100% distribution with its own heat scale.",
      sql: "assets/student-origin/<market>.json (MigrationOnly source)",
      sig: "Where out-of-state students come from."
    },
    "student-migration-in-metros": {
      title: "Top In-State Origin Metros",
      formula: "In-state origin metros ranked by share of in-state migrants.",
      sql: "assets/student-origin/<market>.json (in-state distribution)",
      sig: "The largest in-state feeder metros."
    },
    "student-migration-out-metros": {
      title: "Top Out-of-State Origin Metros",
      formula: "Out-of-state origin metros ranked by share of out-of-state migrants.",
      sql: "assets/student-origin/<market>.json (out-of-state distribution)",
      sig: "The largest out-of-state feeder metros."
    },
    "student-migration-states": {
      title: "Origin States",
      formula: "Origin states ranked by share of all origins (in-state and out-of-state combined).",
      sql: "assets/student-origin/<market>.json",
      sig: "Top sending states overall."
    },
    "shadow-market-map": {
      title: "Off-Campus Student Concentration",
      formula: "Census block-group heatmap of modeled shadow population - college-age renters outside large purpose-built housing. Default metric: shadow-population distribution.",
      sql: "assets/shadow-market/<market>.json: shadow_pop, shadow_hhs, renter_15_24, renter_units_sub50 by block group (ACS B25007 / B25032 / B25033 / B01001 + CoStar)",
      sig: "Neighbourhood concentration of off-campus college-age renters. A distribution aid, not an exact total."
    },
    "shadow-market-rings": {
      title: "Distance-Ring Summary",
      formula: "Per distance ring from campus: CoStar buildings, CoStar 5-49 units, Census 2-4 units, total units, est. population, shadow population. `shadow pop = combined units x local sub-50 occupancy x renter 15-24 share x 18-21 tightening`.",
      sql: "Approved CoStar + Census calculation; each block group is assigned once to its nearest campus ring",
      sig: "Quantifies the shadow market by distance band using the approved CoStar + Census total."
    },
    "uni-profile-table": {
      title: "Undergraduate Student Profile",
      formula: "Residency split, retention, on-campus capacity, tuition, and room & board versus Subtext underwriting targets.",
      sql: "`university_info` (dbo.Schools_Denormal) + `enrollment_history` (dbo.Enrollments_Manual)",
      sig: "The underwriting snapshot of the anchor university."
    },
    "uni-residency-pie": {
      title: "Undergrad Residency",
      formula: "Share of undergraduates on-campus versus domestic off-campus versus international.",
      sql: "`university_info` residency fields (dbo.Schools_Denormal)",
      sig: "The residency split that feeds the off-campus demand picture."
    },
    "uni-admissions-chart": {
      title: "Applications, Acceptance & Yield",
      formula: "Acceptance % and yield % bars (left axis) plus a total-applications line (right axis), first-time first-year, by year.",
      sql: "`admissions_history` <- IPEDS ADM (build_admissions_repository.py -> load_admissions_history.py), 2018-2023",
      sig: "The admissions funnel trend - selectivity and demand for the school."
    },
    "uni-stats-grid": {
      title: "University Statistics",
      formula: "Institutional statistics grid (enrollment scale, retention, selectivity, tuition, and related fields).",
      sql: "`university_info` (dbo.Schools_Denormal) + `enrollment_history` (dbo.Enrollments_Manual)",
      sig: "A reference profile of the institution."
    },
    "enr-chart-fte": {
      title: "Full-Time Enrollment",
      formula: "Full-time enrollment by year with YoY / 2-Yr / 3-Yr growth call-outs.",
      sql: "`enrollment_history` <- dbo.Enrollments_Manual (current-year authority)",
      sig: "The core demand metric - full-time student count trend."
    },
    "enr-chart-freshman": {
      title: "Freshman Enrollment",
      formula: "First-time freshman enrollment by year with YoY / 2-Yr / 3-Yr call-outs.",
      sql: "`enrollment_history` <- dbo.Enrollments_Manual",
      sig: "Incoming-class size, a leading indicator of future demand."
    },
    "enr-chart-total": {
      title: "Total Enrollment",
      formula: "Total enrollment by year with YoY / 2-Yr / 3-Yr call-outs.",
      sql: "`enrollment_history` <- dbo.Enrollments_Manual",
      sig: "Overall enrollment scale and trajectory."
    },
    "uni-map-canvas": {
      title: "Campus Map",
      formula: "Static campus map: boundary polygon, named landmark call-outs, and icon badges for residence halls, Greek life, and nightlife.",
      sql: "assets/campus-boundaries/*.geojson + assets/campus-pois/* (prefetched from OSM Overpass)",
      sig: "Orientation map of campus geography and student-life nodes."
    },

    /* ================= PROPERTY PAGE (property.html) ================= */
    "plans": {
      title: "Floor Plans",
      formula: "One row per floor plan: bed / bath / sf, rate, rate per sf, pre-lease, occupancy.",
      sql: "plans/<property_key>.json <- dbo.Plans (lazy-loaded on page open)",
      sig: "Unit-level pricing and lease-up detail for the property."
    },
    "pm-bar": {
      title: "Inventory by Bedroom Type",
      formula: "Beds (or units) by bedroom type (Studio through 6BR+) for this property.",
      sql: "`unit_mix.beds_by_type` / `units_by_type` from plans/<property_key>.json",
      sig: "The property's product mix by bedroom count."
    },
    "pm-size": {
      title: "Average Unit Size by Unit Type",
      formula: "Average square feet by unit type for this property.",
      sql: "`unit_mix.size_by_unit.avg_sf`",
      sig: "Typical unit footprint by bedroom type."
    },
    "pm-pie": {
      title: "Unit Mix",
      formula: "Nested doughnut - inner ring: bedroom type; outer ring: bath parity (lighter = shared bath).",
      sql: "`unit_mix.parity_by_type`",
      sig: "The property's unit and bath mix at a glance."
    },
    "pm-parity-pie": {
      title: "Bed / Bath Parity",
      formula: "Share of beds (or units) with a private bath versus a shared bath, for the selected bedroom type.",
      sql: "`unit_mix.parity_by_type` full / partial",
      sig: "Bed-to-bath parity for the property."
    },
    "pm-summary-table": {
      title: "Unit Mix Summary",
      formula: "Beds and units by bedroom type with percent of total.",
      sql: "`unit_mix.beds_by_type` / `units_by_type`",
      sig: "Tabular version of the property's unit mix."
    }
  };

  /* KPI tiles, keyed by normalised tile label (en-dashes -> hyphens). */
  var KPI = {
    /* Industry */
    "markets tracked": { title: "Markets Tracked", formula: "Count of markets in the dataset.", sql: "row count of `scorecard`", sig: "The size of the tracked universe." },
    "total existing beds": { title: "Total Existing Beds", formula: "Sum of `existing_beds` across all markets.", sql: "sum(scorecard.existing_beds) <- MarketReports.beds_purpose_built", sig: "Total purpose-built supply tracked." },
    "pipeline beds": { title: "Pipeline Beds", formula: "`beds_lease_up + beds_under_construction + beds_planned`.", sql: "scorecard pipeline fields <- dbo.MarketReports", sig: "Forward supply still to deliver." },
    "bed-weighted avg rent": { title: "Bed-Weighted Avg Rent", formula: "`sum(rent x beds) / sum(beds)` across markets.", sql: "scorecard.avg_rent_per_bed, existing_beds", sig: "The supply-weighted average rent level." },
    /* Market KPI strip */
    "existing beds": { title: "Existing Beds", formula: "`scorecard.existing_beds`.", sql: "<- MarketReports.beds_purpose_built (latest snapshot)", sig: "Purpose-built beds in the market today." },
    "penetration": { title: "Penetration", formula: "`existing_beds / enr_full_time`.", sql: "scorecard.existing_beds, MarketReports.enr_full_time", sig: "Beds per full-time student - how saturated the market is." },
    "fte enrollment": { title: "FTE Enrollment", formula: "`MarketReports.enr_full_time` (IPEDS, refreshed annually per school).", sql: "scorecard.enr_full_time", sig: "The full-time student demand base." },
    "avg rent / bed": { title: "Avg Rent / Bed", formula: "`MarketReports.rate_avg`, bed-weighted across plans.", sql: "scorecard.avg_rent_per_bed", sig: "The market's headline rent level." },
    "rent yoy": { title: "Rent YoY", formula: "`(rent_t - rent_{t-1}) / rent_{t-1}` from market_history.", sql: "market_history.avg_rent_per_bed", sig: "Latest year-over-year rent growth." },
    "occupancy": { title: "Occupancy", formula: "`MarketReports.occupancy` at the latest snapshot.", sql: "scorecard.occupancy", sig: "How full the market runs." },
    "pre-lease": { title: "Pre-lease", formula: "`MarketReports.prelease` at the latest snapshot.", sql: "scorecard.prelease", sig: "Leasing pace for the coming term." },
    "mean origin income": { title: "Mean Origin Income", formula: "Average household income of the census tracts students migrated from.", sql: "`market_affluence` (Migration CSV), computed in load_affluence.py", sig: "A proxy for student-family affluence and rent tolerance." },
    /* Student Migration KPIs */
    "overall in-state mix": { title: "Overall In-State Mix", formula: "In-state migrants / all migrants.", sql: "assets/student-origin/<market>.json", sig: "Share of students originating in-state." },
    "overall out-of-state mix": { title: "Overall Out-of-State Mix", formula: "Out-of-state migrants / all migrants.", sql: "assets/student-origin/<market>.json", sig: "Share of students originating out-of-state." },
    "origin states": { title: "Origin States", formula: "Count of distinct origin states.", sql: "assets/student-origin/<market>.json", sig: "Geographic breadth of the student draw." },
    "origin metros": { title: "Origin Metros", formula: "Count of distinct origin CBSAs.", sql: "assets/student-origin/<market>.json", sig: "Metro-level breadth of the student draw." },
    /* Shadow Market KPIs */
    "shadow population": { title: "Shadow Population", formula: "`combined units x local sub-50 occupancy x renter 15-24 share x 18-21 tightening`.", sql: "assets/shadow-market/<market>.json (approved CoStar + Census)", sig: "Modeled college-age renters outside large purpose-built housing." },
    "costar buildings": { title: "CoStar Buildings", formula: "Count of CoStar multifamily properties with 5-49 units.", sql: "assets/shadow-market/<market>.json", sig: "The approved shadow-inventory building count." },
    "costar units": { title: "CoStar Units", formula: "Units in CoStar 5-49-unit multifamily properties.", sql: "assets/shadow-market/<market>.json", sig: "Approved 5-49-unit inventory." },
    "census 2-4 units": { title: "Census 2-4 Units", formula: "Census renter inventory in 2-4-unit structures (one-unit rentals excluded).", sql: "ACS B25032 (renter units by structure size)", sig: "The small-property gap CoStar does not capture." },
    /* Property KPIs */
    "beds": { title: "Beds", formula: "Total beds at the property.", sql: "plans/<property_key>.json aggregate", sig: "The property's bed count." },
    "year built": { title: "Year Built", formula: "Year the property was delivered.", sql: "properties.yearBuilt", sig: "Vintage - drives comp eligibility (built >= 2020)." },
    "pre-lease (property)": { title: "Pre-Lease", formula: "Bed-weighted pre-lease across plans.", sql: "plans prelease", sig: "Leasing pace for the property." },
    "occupancy (property)": { title: "Occupancy", formula: "Bed-weighted occupancy across plans.", sql: "plans occupancy", sig: "How full the property runs." },
    "avg rent / bed (property)": { title: "Avg Rent / Bed", formula: "Bed-weighted average rate per bed across plans.", sql: "plans rate", sig: "The property's headline rent level." },
    "mi to campus": { title: "Mi to Campus", formula: "Straight-line miles to the closest tracked campus.", sql: "properties.milesToClosestCampus", sig: "Distance drives comp-set eligibility (<= 1.0 mi)." }
  };

  /* ---- rendering helpers --------------------------------------------------- */
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  /* escape, then turn `code` spans into <code> */
  function fmt(s) {
    return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function norm(s) {
    return String(s || "").toLowerCase().replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim();
  }

  function buildPopInner(entry) {
    var html = '<div class="chart-info-head">' + esc(entry.title || "About this metric") + "</div>";
    if (entry.formula) {
      html += '<div class="chart-info-sec"><div class="chart-info-k">Formula</div>' +
        '<div class="chart-info-v">' + fmt(entry.formula) + "</div></div>";
    }
    if (entry.sql) {
      html += '<div class="chart-info-sec"><div class="chart-info-k">Data &amp; SQL source</div>' +
        '<div class="chart-info-v">' + fmt(entry.sql) + "</div></div>";
    }
    if (entry.sig) {
      html += '<div class="chart-info-sec"><div class="chart-info-k">Significance</div>' +
        '<div class="chart-info-v">' + fmt(entry.sig) + "</div></div>";
    }
    if (entry.rows && entry.rows.length) {
      html += '<div class="chart-info-sec"><div class="chart-info-k">Columns</div>' +
        '<table class="chart-info-rows"><tbody>';
      entry.rows.forEach(function (r) {
        html += "<tr><th>" + fmt(r[0]) + "</th><td>" + fmt(r[1]) + "</td></tr>";
      });
      html += "</tbody></table></div>";
    }
    return html;
  }

  /* ---- the single shared popover ------------------------------------------- */
  var pop = null, openBtn = null;

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement("div");
    pop.className = "chart-info-pop";
    pop.setAttribute("role", "dialog");
    pop.hidden = true;
    document.body.appendChild(pop);
    return pop;
  }

  function closePop() {
    if (pop) pop.hidden = true;
    if (openBtn) openBtn.classList.remove("is-open");
    openBtn = null;
  }

  function positionPop(btn) {
    var r = btn.getBoundingClientRect();
    var pw = pop.offsetWidth, ph = pop.offsetHeight;
    var margin = 8;
    var left = r.left;
    // keep within viewport horizontally
    if (left + pw > window.innerWidth - margin) left = window.innerWidth - margin - pw;
    if (left < margin) left = margin;
    // prefer below the icon; flip above if it would overflow
    var top = r.bottom + 6;
    if (top + ph > window.innerHeight - margin && r.top - 6 - ph > margin) {
      top = r.top - 6 - ph;
    }
    pop.style.left = Math.round(left + window.scrollX) + "px";
    pop.style.top = Math.round(top + window.scrollY) + "px";
  }

  function openFor(btn, entry) {
    ensurePop();
    if (openBtn === btn) { closePop(); return; }
    pop.innerHTML = buildPopInner(entry);
    pop.hidden = false;
    openBtn = btn;
    btn.classList.add("is-open");
    positionPop(btn);
  }

  /* ---- button factory + mounting ------------------------------------------- */
  function makeBtn(entry) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chart-info-btn";
    btn.title = "Formula, data source, and significance";
    btn.setAttribute("aria-label", "About: " + (entry.title || "this metric"));
    btn.innerHTML = ICON;
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      openFor(btn, entry);
    });
    return btn;
  }

  function mount(host, entry) {
    if (!host || !entry) return;
    if (host.querySelector(":scope > .chart-info-btn")) return;
    host.appendChild(makeBtn(entry));
  }

  /* element ids that live alone in a plain card -> mount in the card-header h2 */
  var CARD_IDS = [
    "industry-map", "scorecard", "analysis", "map", "properties-all",
    "comp-map-canvas", "properties-comps", "qualifier-list",
    "student-migration-in-map", "student-migration-out-map",
    "student-migration-in-metros", "student-migration-out-metros",
    "student-migration-states", "shadow-market-map", "shadow-market-rings",
    "uni-profile-table", "uni-stats-grid", "uni-map-canvas", "plans"
  ];

  function attach() {
    // 1. Charts: figure.perf-chart -> .perf-title-text (keyed by canvas id)
    document.querySelectorAll("figure.perf-chart").forEach(function (fig) {
      var canvas = fig.querySelector(".perf-chart-wrap canvas") || fig.querySelector("canvas");
      if (!canvas || !REG[canvas.id]) return;
      mount(fig.querySelector(".perf-title-text"), REG[canvas.id]);
    });

    // 2. Detail tables: .comp-table-card -> .comp-table-title (keyed by table id)
    document.querySelectorAll(".comp-table-card").forEach(function (card) {
      var table = card.querySelector("table[id]");
      if (!table || !REG[table.id]) return;
      mount(card.querySelector(".comp-table-title"), REG[table.id]);
    });

    // 3. Plain cards: element id -> nearest .card-header h2
    CARD_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el || !REG[id]) return;
      var card = el.closest(".card");
      if (!card) return;
      mount(card.querySelector(".card-header h2"), REG[id]);
    });

    // 4. KPI tiles: .kpi .kpi-label, keyed by normalised label text. A few
    //    labels collide across pages (Occupancy, Avg Rent / Bed, Pre-lease) -
    //    disambiguate by page so the property page shows the property reading.
    var isProperty = !!document.getElementById("prop-name");
    document.querySelectorAll(".kpi .kpi-label").forEach(function (label) {
      if (label.querySelector(":scope > .chart-info-btn")) return;
      var key = norm(label.textContent);
      if (isProperty) {
        if (key === "pre-lease") key = "pre-lease (property)";
        else if (key === "avg rent / bed") key = "avg rent / bed (property)";
        else if (key === "occupancy") key = "occupancy (property)";
      }
      var entry = KPI[key];
      if (entry) mount(label, entry);
    });
  }

  /* ---- global dismiss handlers --------------------------------------------- */
  document.addEventListener("click", function (e) {
    if (!pop || pop.hidden) return;
    if (pop.contains(e.target)) return;
    if (openBtn && openBtn.contains(e.target)) return;
    closePop();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closePop();
  });
  window.addEventListener("resize", closePop);
  window.addEventListener("scroll", function () { if (openBtn) positionPop(openBtn); }, true);

  /* ---- run now + re-run after lazy renders --------------------------------- */
  var pending = null;
  function schedule() {
    if (pending) return;
    pending = setTimeout(function () { pending = null; attach(); }, 120);
  }
  function start() {
    attach();
    var obs = new MutationObserver(schedule);
    obs.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
