# Scorecard Radius Metrics + Subtext Rank Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 9 columns to the home-page Pipeline Scorecard — Subtext rank plus occupancy / prelease / rent growth at 0.5- and 1.0-mile radii and uncaptured demand (UD) within 1 mile (all-vintage and 2010+) — computed client-side from data already in `data.json`.

**Architecture:** All changes live in `dashboard.js` (compute + column definitions; `PIPELINE_COLS` drives both the on-screen table and the Excel export) and `style.css` (two-line wrapping headers, slightly smaller font). Spec: `docs/superpowers/specs/2026-07-07-scorecard-market-metrics-design.md`.

**Tech Stack:** Vanilla JS (browser), CSS. Verification: throwaway Python oracle + Node `vm` harness in the session scratchpad (`SCRATCH` below), not committed.

**Repo:** `C:\Users\JackBranding\OneDrive - Subtext\Desktop\Subhouse Branches\Market-Data-Dashboard-Version-1`, branch `feature/scorecard-market-metrics`.
**SCRATCH:** `C:\Users\JACKBR~1\AppData\Local\Temp\claude\C--Users-JackBranding-OneDrive---Subtext-Desktop-Subhouse-Branches-Market-Scorecard\37aae0c8-57a7-44e4-be7d-41a883dce6de\scratchpad`

Line numbers below refer to the file state at branch commit `3d66e66`. The Python oracle already exists at `SCRATCH\oracle.py` and its output at `SCRATCH\oracle.json` (24 active markets; regenerate with the command in Task 1 if missing).

---

## Chunk 1: All tasks

### Task 1: Node harness (failing first)

**Files:**
- Create: `SCRATCH\harness.js`
- Uses: `SCRATCH\oracle.py`, `SCRATCH\oracle.json` (already built and validated)

- [ ] **Step 1: Write the harness**

Create `SCRATCH\harness.js`. It evaluates `dashboard.js` in a `vm` sandbox (the only load-time side effect is `document.addEventListener("DOMContentLoaded", ...)`, and `Chart`-guarded blocks short-circuit), injects `DATA`, calls `pipelineScorecardRows()`, and diffs the 9 new fields against the Python oracle plus the exact 23-header order:

```js
const fs = require("fs");
const vm = require("vm");
const [, , dashboardPath, dataPath, oraclePath] = process.argv;

const sandbox = {
  document: { addEventListener() {}, getElementById: () => null },
  window: {},
  console,
};
vm.createContext(sandbox);
sandbox.__DATA__ = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const epilogue = `
;DATA = __DATA__;
__OUT__ = { headers: PIPELINE_COLS.map((c) => c.h), rows: pipelineScorecardRows() };`;
vm.runInContext(fs.readFileSync(dashboardPath, "utf8") + epilogue, sandbox);

const { headers, rows } = sandbox.__OUT__;
const oracle = JSON.parse(fs.readFileSync(oraclePath, "utf8"));
const FIELDS = [
  "fwd_rank", "occ_half_mi", "occ_one_mi", "pre_half_mi", "pre_one_mi",
  "rent_growth_half_mi", "rent_growth_one_mi", "ud_one_mi", "ud_one_mi_2010",
];
const EXPECT = [
  "University", "Subtext Rank", "Total Enrollment", "FTE", "FTE Growth",
  "Occ - 0.5 Mi", "Occ - 1.0 Mi", "Market Occ.",
  "Prelease - 0.5 Mi", "Prelease - 1.0 Mi", "Market Prelease",
  "Rent - 0.5 Mi", "Rent - 1.0 Mi", "Market Rent",
  "Rent Growth - 0.5 Mi", "Rent Growth - 1.0 Mi", "Market Rent Growth",
  "On-Campus Beds", "PBSH Beds", "Pipeline",
  "UD - 1.0 Mi", "UD - 1.0 Mi (2010+)", "UD as FTE %",
];

let bad = 0;
if (JSON.stringify(headers) !== JSON.stringify(EXPECT)) {
  console.error("HEADER MISMATCH\n got:", JSON.stringify(headers));
  bad++;
}
if (rows.length !== Object.keys(oracle).length) {
  console.error(`row count ${rows.length} != oracle ${Object.keys(oracle).length}`);
  bad++;
}
for (const r of rows) {
  const o = oracle[String(r.market_key)];
  if (!o) { console.error("no oracle entry for market", r.market_key); bad++; continue; }
  for (const f of FIELDS) {
    const a = r[f], b = o[f];
    const ok = (a == null && b == null) ||
      (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9);
    if (!ok) { console.error(`MISMATCH mk=${r.market_key} ${f}: js=${a} oracle=${b}`); bad++; }
  }
}
console.log(bad === 0
  ? `PASS - ${rows.length} markets x ${FIELDS.length} fields match oracle; header order OK`
  : `FAIL - ${bad} problems`);
process.exit(bad === 0 ? 0 : 1);
```

- [ ] **Step 2: (If oracle.json is missing) regenerate it**

Run from the repo root:
`python "SCRATCH\oracle.py" data.json "SCRATCH\oracle.json"`
Expected: `oracle: 24 active markets, history years 2025->2026`, an assertion-free run, and an outliers line.

- [ ] **Step 3: Run harness to verify it FAILS against current code**

Run from the repo root:
`node "SCRATCH\harness.js" dashboard.js data.json "SCRATCH\oracle.json"`
Expected: FAIL — header mismatch (current headers lack the 9 new columns) and `occ_half_mi`/etc. mismatches (`js=undefined`). If it errors with a ReferenceError instead, the sandbox stubs need extending — fix the harness, not dashboard.js.

No commit (throwaway tooling, stays in scratchpad).

### Task 2: dashboard.js — compute the new fields

**Files:**
- Modify: `dashboard.js:428-503` (pipelineDerived, bedWeightedRent, pipelineScorecardRows, PIPELINE_COLS)
- Modify: `dashboard.js:521-522` (Excel column widths)

- [ ] **Step 1: Extend `pipelineDerived()` with a per-property rent-growth map**

At `dashboard.js:444`, the function currently ends with:

```js
  _pipelineDerived = { fteGrowth, yoyRent, onCampus, propsByMarket };
  return _pipelineDerived;
```

Replace those two lines with:

```js
  // Per-property YoY rent growth from the annual (June) property_history
  // snapshots: latest year vs the year before. Zero/absent rents drop out.
  const hist = t.property_history || [];
  const years = [...new Set(hist.map((h) => h.year_))].sort((a, b) => a - b);
  const rentGrowth = new Map();
  if (years.length >= 2) {
    const [prior, latest] = years.slice(-2);
    const cur = new Map(), prev = new Map();
    for (const h of hist) {
      if (!(h.avg_rent_per_bed > 0)) continue;
      if (h.year_ === latest) cur.set(h.property_key, h.avg_rent_per_bed);
      else if (h.year_ === prior) prev.set(h.property_key, h.avg_rent_per_bed);
    }
    for (const [pk, c] of cur) {
      const p = prev.get(pk);
      if (p) rentGrowth.set(pk, c / p - 1);
    }
  }
  _pipelineDerived = { fteGrowth, yoyRent, onCampus, propsByMarket, rentGrowth };
  return _pipelineDerived;
```

- [ ] **Step 2: Generalize `bedWeightedRent` → `bedWeighted` and add the UD helper**

Replace the whole function at `dashboard.js:448-457` (comment + `bedWeightedRent`) with:

```js
// Bed-weighted avg of getter(p) across a market's properties within `maxMi`
// of campus. Properties missing the value or a bed count are skipped.
function bedWeighted(props, maxMi, getter) {
  let num = 0, den = 0;
  for (const p of props) {
    const v = getter(p);
    if (v == null || !p.beds) continue;
    if (maxMi != null && (p.milesToClosestCampus == null || p.milesToClosestCampus > maxMi)) continue;
    num += v * p.beds; den += p.beds;
  }
  return den ? num / den : null;
}

// Uncaptured demand within 1 mile: share of FTE not yet served by PBSH beds
// near campus - mirrors the uncaptured_1mi qualifier in export-data.py.
// `minYear` restricts the supply side to newer vintages (e.g. built 2010+).
function uncapturedWithinMile(props, fte, minYear) {
  if (!fte) return null;
  let beds = 0;
  for (const p of props) {
    if (!p.beds || p.milesToClosestCampus == null || p.milesToClosestCampus > 1.0) continue;
    if (minYear != null && !(p.yearBuilt >= minYear)) continue;
    beds += p.beds;
  }
  return 1 - beds / fte;
}
```

(`!(p.yearBuilt >= minYear)` deliberately drops null/undefined `yearBuilt` from the 2010+ vintage count.)

- [ ] **Step 3: Emit the new fields from `pipelineScorecardRows()`**

The row-mapping block (originally `dashboard.js:471-481`) currently reads:

```js
      const props = d.propsByMarket.get(r.market_key) || [];
      return {
        ...r,
        fte_growth_yoy: d.fteGrowth.get(r.market_key) ?? null,
        yoy_rent_growth: d.yoyRent.get(r.market_key) ?? null,
        on_campus_beds: d.onCampus.get(r.market_key) ?? null,
        rent_half_mi: bedWeightedRent(props, 0.5),
        rent_one_mi: bedWeightedRent(props, 1.0),
        uncaptured_demand: r.penetration_ratio != null ? 1 - r.penetration_ratio : null,
      };
```

Replace with:

```js
      const props = d.propsByMarket.get(r.market_key) || [];
      // Zero occupancy/prelease means "not reporting" in the export (under-
      // construction / pre-delivery assets), not a real 0% - drop them.
      const occ = (p) => p.occupancy || null;
      const pre = (p) => p.prelease || null;
      const growth = (p) => d.rentGrowth.get(p.property_key) ?? null;
      return {
        ...r,
        fte_growth_yoy: d.fteGrowth.get(r.market_key) ?? null,
        yoy_rent_growth: d.yoyRent.get(r.market_key) ?? null,
        on_campus_beds: d.onCampus.get(r.market_key) ?? null,
        rent_half_mi: bedWeighted(props, 0.5, (p) => p.avg_rent),
        rent_one_mi: bedWeighted(props, 1.0, (p) => p.avg_rent),
        occ_half_mi: bedWeighted(props, 0.5, occ),
        occ_one_mi: bedWeighted(props, 1.0, occ),
        pre_half_mi: bedWeighted(props, 0.5, pre),
        pre_one_mi: bedWeighted(props, 1.0, pre),
        rent_growth_half_mi: bedWeighted(props, 0.5, growth),
        rent_growth_one_mi: bedWeighted(props, 1.0, growth),
        ud_one_mi: uncapturedWithinMile(props, r.enr_full_time, null),
        ud_one_mi_2010: uncapturedWithinMile(props, r.enr_full_time, 2010),
        uncaptured_demand: r.penetration_ratio != null ? 1 - r.penetration_ratio : null,
      };
```

- [ ] **Step 4: Replace `PIPELINE_COLS` with the 23-column layout**

Replace the whole array at `dashboard.js:486-501` with (order per spec: 0.5 mi → 1.0 mi → market within each family):

```js
const PIPELINE_COLS = [
  { h: "University",           uni: true },
  { h: "Subtext Rank",         get: (r) => r.fwd_rank,            fmt: fmtInt,           xz: "#,##0" },
  { h: "Total Enrollment",     get: (r) => r.total_enrollment,    fmt: fmtInt,           xz: "#,##0" },
  { h: "FTE",                  get: (r) => r.enr_full_time,       fmt: fmtInt,           xz: "#,##0" },
  { h: "FTE Growth",           get: (r) => r.fte_growth_yoy,      fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Occ - 0.5 Mi",         get: (r) => r.occ_half_mi,         fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Occ - 1.0 Mi",         get: (r) => r.occ_one_mi,          fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Market Occ.",          get: (r) => r.occupancy,           fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Prelease - 0.5 Mi",    get: (r) => r.pre_half_mi,         fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Prelease - 1.0 Mi",    get: (r) => r.pre_one_mi,          fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Market Prelease",      get: (r) => r.prelease,            fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Rent - 0.5 Mi",        get: (r) => r.rent_half_mi,        fmt: fmtUsd,           xz: "$#,##0" },
  { h: "Rent - 1.0 Mi",        get: (r) => r.rent_one_mi,         fmt: fmtUsd,           xz: "$#,##0" },
  { h: "Market Rent",          get: (r) => r.avg_rent_per_bed,    fmt: fmtUsd,           xz: "$#,##0" },
  { h: "Rent Growth - 0.5 Mi", get: (r) => r.rent_growth_half_mi, fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Rent Growth - 1.0 Mi", get: (r) => r.rent_growth_one_mi,  fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "Market Rent Growth",   get: (r) => r.yoy_rent_growth,     fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "On-Campus Beds",       get: (r) => r.on_campus_beds,      fmt: fmtInt,           xz: "#,##0" },
  { h: "PBSH Beds",            get: (r) => r.existing_beds,       fmt: fmtInt,           xz: "#,##0" },
  { h: "Pipeline",             get: (r) => r.beds_pipeline_total, fmt: fmtInt,           xz: "#,##0" },
  { h: "UD - 1.0 Mi",          get: (r) => r.ud_one_mi,           fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "UD - 1.0 Mi (2010+)",  get: (r) => r.ud_one_mi_2010,      fmt: (v) => fmtPct(v), xz: "0.0%" },
  { h: "UD as FTE %",          get: (r) => r.uncaptured_demand,   fmt: (v) => fmtPct(v), xz: "0.0%" },
];
```

- [ ] **Step 5: Narrow the Excel numeric columns**

In `downloadScorecardExcel()` (originally `dashboard.js:521-522`), change:

```js
    ws.getColumn(1).width = 34;
    for (let i = 2; i <= nCol; i++) ws.getColumn(i).width = 13;
```

to:

```js
    ws.getColumn(1).width = 34;
    for (let i = 2; i <= nCol; i++) ws.getColumn(i).width = 11;
```

- [ ] **Step 6: Run the harness to verify it PASSES**

Run: `node "SCRATCH\harness.js" dashboard.js data.json "SCRATCH\oracle.json"`
Expected: `PASS - 24 markets x 9 fields match oracle; header order OK`, exit 0.

- [ ] **Step 7: Commit**

```bash
git add dashboard.js
git commit -m "Add radius occupancy/prelease/rent-growth, UD, and Subtext rank scorecard columns"
```

### Task 3: style.css — fit 23 columns

**Files:**
- Modify: `style.css:814-857` (`.pipeline-table` block)

- [ ] **Step 1: Apply the four CSS changes**

In the `.pipeline-table` rules (style.css:814-861):

1. `.pipeline-table` (line 814): `min-width: 1180px;` → `min-width: 1420px;` and `font-size: 11.5px;` → `font-size: 10.5px;`
2. `.pipeline-table .stage-head th` (line 843): `font-size: 9.5px;` → `font-size: 9px;`, `white-space: nowrap;` → `white-space: normal;`, and add two properties: `line-height: 1.15;` and `vertical-align: bottom;`
3. `.pipeline-table tbody td` (line 856): `padding: 6px 10px;` → `padding: 6px 7px;`

- [ ] **Step 2: Visual check in the browser**

From the repo root run `python -m http.server 8000`, open `http://localhost:8000/index.html`:
- Market Scorecard shows 23 columns; headers wrap to ≤2 lines; values render with the muted `-` for gaps.
- Spot-check University of Utah: Occ - 0.5 Mi ≈ 97.6%, Occ - 1.0 Mi ≈ 97.7%, UD - 1.0 Mi ≈ 87.9% (oracle values).
- Row click still navigates to `market.html?id=...`.
- Table fits without horizontal scroll at ~1600px+ viewport; scrolls gracefully when narrower.
Stop the server afterward.

- [ ] **Step 3: Commit**

```bash
git add style.css
git commit -m "Wrap scorecard headers to two lines and tighten font to fit 23 columns"
```

### Task 4: Push branch to fork

- [ ] **Step 1: Final verification**

Run the harness once more (expected PASS) and `git status` (expected: clean tree, only plan/spec docs + two code commits ahead of main).

- [ ] **Step 2: Push**

```bash
git push -u fork feature/scorecard-market-metrics
```

Expected: new branch on `jacksubtextuse-ux/Market-Data-Dashboard-Version-1`.
