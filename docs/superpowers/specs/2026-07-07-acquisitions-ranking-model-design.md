# Acquisitions Ranking Model — Forward Model Tab Design Spec

Date: 2026-07-07
Status: Approved (design), implementation starting
Branch: `feature/acquisitions-ranking-model` (local until user sign-off; nothing pushed before review)

## Goal

Add the acquisitions ranking model to the dashboard's Forward Model tab as a second
option alongside the existing development screener. The Forward Model view gets a
`[Development] [Acquisitions]` pill toggle; Acquisitions shows the ranking from
`Acquisition Screener - 2024.xlsx` in the same self-contained-page format as the
existing `forward-model.html`. Development remains the default and is otherwise
unchanged.

## Source data

- Workbook: `Acquisition Screener - 2024.xlsx`
  (lives at `..\Aquisitions Ranking Model\Acquisition Screener - 2024.xlsx`
  relative to the repo, on the user's OneDrive).
- Sheet: `Forward Looking Model` (used range A1:AH115). Loaded with openpyxl
  `read_only=True, data_only=True` (cached formula values; the workbook is 58 MB).
- Values columns (A–N): Current Year Ranking, Forward Looking Ranking, Change,
  Market, Full Time Enrollment, TTM Prelease, PBSH Occupancy, 3 Year Change In
  Student Bed To Enrollment Ratio, TTM Prelease Change, Three Year Change In
  Applications, POSH Occupancy Last Year, Growth In FT OoS Undergrads,
  Strongest Variable, Weakest Variable.
- Weightings columns (Q–AE): weighted contribution scores for the seven model
  variables (TTM Prelease, PBSH Occupancy, 3yr Bed/Enroll Δ, TTM Prelease Δ,
  3yr App Growth, POSH Occ LY, FT OoS UG Growth) plus Transactions Last 5,
  Transactions Previous 5, Construction Last 5, Construction Previous 5,
  Power 4 (0/1), R1 (0/1), Rent/Price, Current New Property Rent.
  Column AF (`sum`) is not displayed, matching the development page.
- Row filter: drop any row whose Market or Forward Looking Ranking is empty or
  an `#N/A` error string. At design time that keeps 79 markets and drops 35
  broken rows. Sort by Forward Looking Ranking ascending.
- Out of scope (decided): the `Compare` sheet's six scenario rankings, the
  exclusion filters from the meeting notes (cols AG/AH), and the
  `Current Model` sheet. The Forward Looking Model sheet already carries the
  current-year rank used by the Change column.

## Deliverables

All on branch `feature/acquisitions-ranking-model`:

1. `build_acquisitions_model.py` — new builder script (repo `build_*.py` convention).
2. `acquisitions-model.html` — generated, committed output.
3. `index.html` + `style.css` — Development/Acquisitions toggle in the Forward
   Model view.
4. This spec.

## Builder (`build_acquisitions_model.py`)

- Python 3 + openpyxl. CLI: `python build_acquisitions_model.py [--xlsx PATH]`;
  the default PATH is the OneDrive location above so the routine refresh is a
  bare `python build_acquisitions_model.py`.
- Validates before writing: workbook opens, sheet `Forward Looking Model`
  exists, row-1 headers match the expected names, and at least one valid data
  row survives the row filter. Any failure exits non-zero with a clear message
  and writes nothing. Prints kept/dropped row counts on success.
- Writes `acquisitions-model.html` into the repo root next to
  `forward-model.html`.
- The page template (CSS/JS/callouts) is embedded in the builder so the output
  is fully self-contained, mirroring how `forward-model.html` works.

## Generated page (`acquisitions-model.html`)

A structural clone of `forward-model.html` — same inline CSS, same two-tab
layout, same sortable-column and tab JS, same print styles — with:

- `<title>` "Forward Looking Model - Acquisition Screener 2024"; header h1
  "Forward Looking Model - Acquisition Screener"; same PBSH subtitle and FCST
  legend pill.
- Sub-tabs keep the labels "Forward Looking Values" and
  "Forward Looking Weightings".
- Footer source line on both tabs: "Acquisition Screener – 2024.xlsx ·
  Forward Looking Model tab | Generated YYYY-MM-DD" (build date).
- Values tab: same 14 columns and callout definitions as the development page.
- Weightings tab: same 17 columns and callout definitions as the development
  page (which already includes the transactions / construction / Power 4 / R1 /
  rent-price / new-property-rent columns).

Formatting rules, matching the development page exactly:

| Field | Format |
|---|---|
| FT Enrollment | thousands-comma integer |
| TTM Prelease, 3yr App Growth, POSH Occ LY, FT OoS UG Growth | integer % |
| PBSH Occ, 3yr Bed/Enroll Δ, TTM Prelease Δ | one-decimal % |
| Weighting scores (7 variables) | two decimals; class `w-pos` / `w-neg`; `w-zero` when the value rounds to 0.00 |
| Transaction / construction counts | integer |
| Power 4, R1 | ✓ `flag-yes` when 1, – `flag-no` when 0 |
| Rent/Price | one-decimal %; "-" when blank |
| Current New Property Rent | $ + thousands-comma integer |
| Fwd/Curr rank | badges `rank-forward` / `rank-current` |
| Change | badge `change-up` (+N) / `change-down` (−N) / `change-zero` (0) |
| Strongest / Weakest Variable | `tag-strong` / `tag-weak` tags |

- Metric cell coloring on the values tab: tercile within each metric column by
  value — top third `metric-hi`, middle `metric-mid`, bottom third `metric-lo`
  (the rule reverse-engineered from the development page's generated classes).
- Blank / non-numeric cells in any displayed column render as "-" (the
  Rent/Price rule generalized) and are excluded from tercile bucketing.
- Forecast columns (3yr Bed/Enroll Δ, 3yr App Growth) get the `fcast-col`
  header treatment and FCST badges, and the same fcast-cell JS tagging indices
  updated if column positions differ (they don't — layout is identical).
- The page carries all three of the development page's script blocks: tab
  switching, sortable columns, and the runtime color-inversion for
  3yr Bed/Enroll Δ (values `td[7]` swaps `metric-hi`↔`metric-lo`; weightings
  `td[4]` swaps `w-pos`↔`w-neg`, since lower supply growth is better). The
  builder emits raw tercile/sign classes and lets that script invert at
  runtime, exactly as the development page does — the inversion must not also
  be baked into the generated classes (double-apply would cancel it).

## Toggle (`index.html`, `style.css`)

- Inside the existing `#forward-view` section: a pill toggle bar
  `[Development] [Acquisitions]` above the model, Development active by default.
- Two iframes: the existing `forward-model.html` iframe (unchanged, still the
  default) and a new `acquisitions-model.html` iframe with `loading="lazy"`,
  hidden until first selected. The new iframe reuses the existing
  `.forward-frame` class for its sizing/border treatment.
- Switching shows/hides the iframes (CSS class), never swaps `src`, so each
  model keeps its scroll position and selected sub-tab across flips.
- Toggle styling added to `style.css`, consistent with existing dashboard pills.
- Brand-CSS injection: `dashboard.js`'s `brandForwardModel()` injects
  `forward-model-brand.css` into the *first* `.forward-frame` only — which is
  currently the Market State iframe, so the development model receives no
  injection today (pre-existing quirk). Decision: leave `dashboard.js`
  untouched; the acquisitions iframe likewise receives no injection, so both
  toggle options render with identical styling. The quirk is recorded under
  Notes as a separate follow-up candidate.
- No sidebar, hash-routing, or other-tab changes.

## Error handling

- Builder: fail-loud validation as above; no partial output file on failure.
- Page: static HTML, no runtime data fetch, so no new runtime failure modes.
  If the acquisitions iframe file is missing the browser shows a 404 inside the
  frame only; the Development model is unaffected.

## Verification

1. Run the builder; confirm kept/dropped counts (expect 79 kept / 35 dropped).
2. Serve the repo locally (`python -m http.server`), open the dashboard,
   toggle both directions, exercise both sub-tabs and column sorting on the
   acquisitions page.
3. Spot-check at least 5 markets against the Excel — UConn (#1), Missouri
   (#2), Rutgers (#3), plus two mid-table markets — on both the values and
   weightings tabs.
4. Confirm the Development model renders and behaves exactly as before.
5. User examines locally in their browser. Push / PR happens only after their
   sign-off.

## Notes

- The GitHub repo is public; this adds the internal acquisitions ranking to it,
  the same exposure the development model already has. Accepted at design time;
  the pre-push review is the checkpoint.
- The stale OneDrive folder copy `Market-Data-Dashboard-Version-1-main` is not
  touched; all work happens in the git clone `Market-Data-Dashboard-Version-1`.
- Pre-existing quirk (out of scope, follow-up candidate): `brandForwardModel()`
  in `dashboard.js` was written to re-skin the forward-model iframe, but since
  the Market State section was added before it in the DOM, the brand stylesheet
  now lands in the Market State iframe instead. Fixing the selector would
  change the forward model's current appearance, so it is deliberately not
  bundled into this feature.

## Out of scope / later

- Compare-sheet scenario views and exclusion-filtered rankings.
- Any automated refresh pipeline for the acquisitions Excel.
- Surfacing acquisitions rank on the Industry scorecard (the existing
  `fwd_rank` column there refers to the development model only).
