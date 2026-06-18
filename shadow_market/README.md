# Shadow-market batch data

This folder generates static Census block-group results consumed by the
dashboard's market detail page.

```powershell
python shadow_market/generate.py --market-key 86 --costar-csv ..\CoStarProperties.csv
```

Output is written to `assets/shadow-market/<market_key>.json`. The dashboard
never calls Census APIs in the browser.

Each market must be added to `markets.json` with its dashboard `market_key`,
anchor campus coordinates, county FIPS codes, distance rings, and ACS years.
The raw CoStar export is intentionally kept outside this public repository.
Pass it with `--costar-csv`, set `COSTAR_CSV_PATH`, or place
`CoStarProperties.csv` beside the dashboard repository.

The approved calculation uses:

- CoStar multifamily properties with 5–49 units
- Census 2–4-unit renter inventory (one-unit rentals are excluded)
- Census block-group occupancy and college-age renter shares
- 18–21 as the default college-age window

The latest ACS release can fall back to Census Reporter; historical uncached
runs require `CENSUS_API_KEY`.

`methodology_version` in the generated asset must be incremented when the
calculation changes.
