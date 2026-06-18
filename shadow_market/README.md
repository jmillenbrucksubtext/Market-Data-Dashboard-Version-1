# Shadow-market batch data

This folder generates static Census block-group results consumed by the
dashboard's market detail page.

```powershell
python shadow_market/generate.py --market-key 86
```

Output is written to `assets/shadow-market/<market_key>.json`. The dashboard
never calls Census APIs in the browser.

Each market must be added to `markets.json` with its dashboard `market_key`,
anchor campus coordinates, county FIPS codes, distance rings, and ACS years.
The latest ACS release can fall back to Census Reporter; historical uncached
runs require `CENSUS_API_KEY`.

`methodology_version` in the generated asset must be incremented when the
calculation changes.
