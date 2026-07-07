# Market Scorecard: Radius Metrics + Subtext Rank Columns

**Date:** 2026-07-07
**Branch:** `feature/scorecard-market-metrics` (off `main`)
**Status:** Approved by Jack (2026-07-07)

## Goal

Add nine columns to the Pipeline Scorecard on the subhouse home page (`index.html`
"Market Scorecard" card, rendered by `renderScorecard()` in `dashboard.js`):
Subtext ranking, occupancy at 0.5/1.0 mile, prelease at 0.5/1.0 mile, YoY rent
growth at 0.5/1.0 mile, uncaptured demand (UD) within 1 mile, and UD within
1 mile counting only 2010+ vintage supply.

All metrics are computed client-side from tables already present in
`data.json` — no changes to `export-data.py`, no data.json regeneration, and
no new database dependency. This mirrors how the existing "Rent - 0.5 Mile" /
"Rent - 1.0 Mile" columns are derived (`bedWeightedRent()`).

## Decisions made with Jack

1. **"UD" = Uncaptured Demand**, consistent with the existing "UD as FTE %"
   column and the `uncaptured_1mi` qualifier in `export-data.py`
   (`_q_uncaptured_demand`): `1 − (PBSH beds within radius ÷ FTE)`.
2. **"Subtext ranking" = forward model rank** — the `fwd_rank` field already
   present on each scorecard row in `data.json` (lower = better).
3. **Column-group order: 0.5 mi → 1.0 mi → market-wide** within each metric
   family. This also reorders the existing rent columns.
4. **Width handling:** keep all existing columns (23 total). Headers may wrap
   to two lines; shrink the table font slightly. Horizontal scroll in
   `.pipeline-wrap` remains the fallback.

## Column layout (final order)

| # | Header | Source | Format |
|---|--------|--------|--------|
| 1 | University | existing | text |
| 2 | Subtext Rank | `r.fwd_rank` | integer |
| 3 | Total Enrollment | existing | int |
| 4 | FTE | existing | int |
| 5 | FTE Growth | existing | pct |
| 6 | Occ - 0.5 Mi | **new** `occ_half_mi` | pct |
| 7 | Occ - 1.0 Mi | **new** `occ_one_mi` | pct |
| 8 | Market Occ. | existing | pct |
| 9 | Prelease - 0.5 Mi | **new** `pre_half_mi` | pct |
| 10 | Prelease - 1.0 Mi | **new** `pre_one_mi` | pct |
| 11 | Market Prelease | existing | pct |
| 12 | Rent - 0.5 Mi | existing `rent_half_mi` (moved) | USD |
| 13 | Rent - 1.0 Mi | existing `rent_one_mi` (moved) | USD |
| 14 | Market Rent | existing (moved after radius rents) | USD |
| 15 | Rent Growth - 0.5 Mi | **new** `rent_growth_half_mi` | pct |
| 16 | Rent Growth - 1.0 Mi | **new** `rent_growth_one_mi` | pct |
| 17 | Market Rent Growth | existing `yoy_rent_growth` (renamed from "YoY Rent Growth") | pct |
| 18 | On-Campus Beds | existing | int |
| 19 | PBSH Beds | existing | int |
| 20 | Pipeline | existing | int |
| 21 | UD - 1.0 Mi | **new** `ud_one_mi` | pct |
| 22 | UD - 1.0 Mi (2010+) | **new** `ud_one_mi_2010` | pct |
| 23 | UD as FTE % | existing | pct |

## Metric definitions

All computed per market in `pipelineScorecardRows()` from
`DATA.tables.properties` (fields: `beds`, `occupancy`, `prelease`, `avg_rent`,
`yearBuilt`, `milesToClosestCampus`, `market_key`, `property_key`) and
`DATA.tables.property_history` (fields: `property_key`, `year_`,
`avg_rent_per_bed`).

**Radius membership:** property counts toward radius R iff
`milesToClosestCampus != null && milesToClosestCampus <= R`. Same rule as the
existing `bedWeightedRent()` and `_q_uncaptured_demand`.

**Bed-weighted average (generalized):** `bedWeightedRent(props, maxMi)` is
generalized to `bedWeighted(props, maxMi, getter)` — skip properties where
`getter(p) == null` or `!p.beds`; result `Σ(value·beds) / Σ(beds)`, `null`
when no qualifying properties. `bedWeightedRent` becomes
`bedWeighted(props, maxMi, p => p.avg_rent)`.

- **Occ - 0.5/1.0 Mi:** `bedWeighted(props, R, p => p.occupancy)`. Properties
  not reporting occupancy (e.g. under construction / planned) drop out via the
  null guard.
- **Prelease - 0.5/1.0 Mi:** `bedWeighted(props, R, p => p.prelease)`.
- **Rent Growth - 0.5/1.0 Mi:** built from `property_history`, which holds
  annual (June) snapshots per property. In `pipelineDerived()`, compute once:
  `latestYear = max(year_)`, `priorYear = latestYear − 1`; map
  `property_key → growth` where `growth = cur/prev − 1` for properties with
  `avg_rent_per_bed` present and > 0 in **both** years. Then per market/radius:
  bed-weighted average of per-property growth (weights = current `beds` from
  the properties table), `null` if no qualifying properties.
- **UD - 1.0 Mi:** `fte = r.enr_full_time`; if `!fte` → `null`. Else
  `1 − (Σ beds of props within 1.0 mi) / fte`. Exactly mirrors
  `_q_uncaptured_demand` in export-data.py (all phases count if `beds` truthy).
  Value may be negative (over-supplied); render as-is.
- **UD - 1.0 Mi (2010+):** same, but only properties with
  `yearBuilt != null && yearBuilt >= 2010` count as supply. (Jack offered
  "2010+ or within 15 years"; `yearBuilt` supports the exact 2010 cutoff.)
- **Subtext Rank:** `r.fwd_rank` verbatim; `null` → muted "-".

## Rendering & styling

- `PIPELINE_COLS` in `dashboard.js` is the single source of truth for both the
  on-screen table and the Excel export (`downloadScorecardExcel()`), so new
  columns flow into the export automatically. New pct columns use
  `fmt: fmtPct`, `xz: "0.0%"`; Subtext Rank uses `fmtInt`, `xz: "#,##0"`.
- `style.css` `.pipeline-table`: font-size 11.5px → 10.5px; header cells
  (`.stage-head th`) `white-space: normal` with `line-height: 1.15`,
  `vertical-align: bottom`, font-size 9.5px → 9px so labels wrap to two lines;
  cell padding 6px 10px → 6px 7px; `min-width` 1180px → 1420px.
- Excel column widths: first column 34 stays; numeric columns 13 → 11 to keep
  the wider sheet manageable.
- Missing values keep the existing muted "-" convention. Row sort stays A-Z by
  anchor university within each stage. No sorting changes.

## Error handling

- Markets with no properties in radius, no FTE, or no two-year rent history →
  `null` → "-". No division by zero: every denominator (`Σ beds`, `fte`,
  `prev rent`) is guarded.
- `property_history` missing entirely (`DATA.tables.property_history`
  undefined) → rent-growth maps empty → all "-", no crash (use `|| []`).

## Testing / verification

1. **Oracle script (Python):** compute all nine new values for every active
   market straight from `data.json` using the definitions above.
2. **JS harness (Node):** load `dashboard.js` with stubbed `document`/`window`
   globals and injected `DATA`, call `pipelineScorecardRows()`, and diff every
   new field against the Python oracle (tolerance 1e-9).
3. **Visual check:** serve the repo (`python -m http.server`) and confirm the
   23-column table renders, headers wrap to two lines, no horizontal overflow
   at 1080p, and clicking rows still opens market pages.
4. Excel export is asserted by (2) driving off the same `PIPELINE_COLS`.

## Out of scope

- No changes to `export-data.py`, the SQL pipeline, or `data.json`.
- No changes to the Industry tab scorecard, market.html, or qualifier logic.
- No column sorting/re-ordering UI.
