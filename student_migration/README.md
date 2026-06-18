# Student migration assets

This generator converts the raw `MigrationOnly.csv` export into static assets
for the Student Migration tab.

```powershell
python student_migration/generate.py --source "..\MigrationOnly.csv"
```

The raw export stays outside this public repository. The generator also accepts
`STUDENT_MIGRATION_CSV_PATH`. It matches `UNIQUEID` exactly to
`campus_locations.ipeds_id`, writes one asset per dashboard market to
`assets/student-origin/<market_key>.json`, and writes the complete match,
deduplication, suppression, geography, and generated-file audit to
`student_migration/audit.json`.

`State` is used for state totals and in-state/out-of-state calculations.
`CBSAID` is used for the metro heatmap. Metro names and internal-point
coordinates come from the U.S. Census Bureau 2021 CBSA Gazetteer because that
vintage exactly covers the source's valid CBSA codes. `99999` and `NA` remain in
state totals but are not assigned guessed metro coordinates.

In-state and out-of-state origins are normalized independently. Every in-state
CBSA share is divided by the university's in-state total, and every out-of-state
CBSA share is divided by its out-of-state total. Each heatmap therefore
represents its own 100% distribution.

The source file does not include a reporting-period field. Generated assets
state that limitation explicitly.
