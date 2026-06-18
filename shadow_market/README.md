# Shadow-market batch data

This folder generates static Census block-group results consumed by the
dashboard's market detail page.

```powershell
python shadow_market/build_configs.py --costar-csv ..\CoStarProperties.csv
python shadow_market/generate.py --costar-csv ..\CoStarProperties.csv
```

Output is written to `assets/shadow-market/<market_key>.json`. The dashboard
never calls Census APIs in the browser.

`build_configs.py` rebuilds `markets.json` directly from the dashboard. The
scope is one unique `market_key` for every Power 4 anchor or pursuit already
tracked in `data.json`; Subtext-30 markets are included within that scope and
are not added a second time. `market-audit.json` records the resolved campus,
CoStar label, county coverage, and scope flags for review.

Each market uses only its exact anchor-campus row. Repeated enrollment-year
campus rows are collapsed, CoStar university names must match one configured
label exactly, CoStar properties are deduplicated by PropertyID (or location
fallback), and each Census block group is included once.

The raw CoStar export is intentionally kept outside this public repository.
Pass it with `--costar-csv`, set `COSTAR_CSV_PATH`, or place
`CoStarProperties.csv` beside the dashboard repository.

The approved calculation uses:

- CoStar multifamily properties with 5–49 units
- Census 2–4-unit renter inventory (one-unit rentals are excluded)
- Census block-group occupancy and college-age renter shares
- 18–21 as the default college-age window

Each property and Census block group is assigned once within a market.

Without `CENSUS_API_KEY`, the configured 2024 run uses Census Reporter.
Historical uncached runs require a Census API key.

`methodology_version` in the generated asset must be incremented when the
calculation changes.
