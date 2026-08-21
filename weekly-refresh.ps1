# weekly-refresh.ps1
# Refreshes data.json + plans/*.json from Azure SQL on a weekly schedule.
#
# Auth: SQL login. Username + password are loaded from .sql-cred.xml, which
# is a DPAPI-encrypted blob written by Export-Clixml. The file is decryptable
# ONLY by the same Windows user account on the same machine — so even if it
# leaks (e.g. accidental git commit, which .gitignore also blocks), it's
# useless elsewhere. The plaintext password lives only in this process's
# environment for the duration of the python call, then is cleared.
#
# Designed to be invoked unattended by Task Scheduler, OR manually from a
# PowerShell prompt. Logs to .\refresh.log (rotated at 1 MB).
#
# Re-issue the cred file (e.g. after a password rotation) with:
#   $sec  = ConvertTo-SecureString -String '<newpass>' -AsPlainText -Force
#   $cred = New-Object PSCredential 'MitchKorte', $sec
#   $cred | Export-Clixml -Path .sql-cred.xml

[CmdletBinding()]
param(
    # Opt-in: commit + push origin/main after refresh. When set, EVERYTHING in
    # the working tree (modified + untracked) is staged with `git add -A` so
    # the live Cloudflare Worker deploy mirrors local state — not just the
    # data file. Anything secret-looking is blocked before commit as defense
    # in depth, but .gitignore is the primary protection.
    [switch]$Push
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$logFile  = Join-Path $PSScriptRoot "refresh.log"
$credFile = Join-Path $PSScriptRoot ".sql-cred.xml"

if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 1MB)) {
    Move-Item $logFile "$logFile.1" -Force
}

function Write-Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $logFile -Value $line -Encoding utf8
    Write-Host $line
}

Write-Log "=== weekly-refresh start (Push=$($Push.IsPresent)) ==="

if (-not (Test-Path $credFile)) {
    Write-Log "FAIL .sql-cred.xml is missing; see header of this script to regenerate."
    exit 2
}

$cred = Import-Clixml -Path $credFile

# Sync the Forward Model pages BEFORE the SQL export: export-data.py parses
# forward_ranks out of forward-model.html. build_forward_model.py copies the
# data-science team's published "Forward Looking Model Dashboard.html" from
# OneDrive (soft-skips when the source file is absent, hard-fails if its
# layout drifted). acquisitions-model.html is then rebuilt from its workbook
# using the fresh forward page as the design template.
# Same stderr caveat as the git section below: under EAP=Stop, 2>&1 turns any
# benign stderr line (e.g. an openpyxl warning) into a terminating error, so
# drop to Continue around the native python calls and judge by exit code.
$prevBuildEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
python -u build_forward_model.py 2>&1 | ForEach-Object { Add-Content -Path $logFile -Value "$_" -Encoding utf8; "$_" } | Out-Host
if ($LASTEXITCODE -ne 0) {
    Write-Log "FAIL build_forward_model.py exited $LASTEXITCODE"
    $ErrorActionPreference = $prevBuildEAP
    exit $LASTEXITCODE
}

$acqXlsx = "C:\Users\JakeMillenbruck\Subtext\Subtext - Documents\General\Investment\Investment\Research - Analysis\Student Market Analysis\Live Rankings\2026 Rebuild\Acquisition Screener - 2024.xlsx"
if (Test-Path $acqXlsx) {
    python -u build_acquisitions_model.py 2>&1 | ForEach-Object { Add-Content -Path $logFile -Value "$_" -Encoding utf8; "$_" } | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Log "FAIL build_acquisitions_model.py exited $LASTEXITCODE"
        $ErrorActionPreference = $prevBuildEAP
        exit $LASTEXITCODE
    }
} else {
    Write-Log "Acquisition Screener workbook not found ($acqXlsx); preserving existing acquisitions-model.html"
}
$ErrorActionPreference = $prevBuildEAP

$dataBefore = if (Test-Path "data.json") { (Get-FileHash data.json -Algorithm SHA1).Hash } else { "" }
$shadowBefore = if (Test-Path "assets\shadow-market") {
    (Get-ChildItem "assets\shadow-market" -Filter *.json -File |
        Sort-Object Name |
        ForEach-Object { (Get-FileHash $_.FullName -Algorithm SHA1).Hash }) -join "|"
} else { "" }
$studentMigrationBefore = if (Test-Path "assets\student-origin") {
    (Get-ChildItem "assets\student-origin" -Filter *.json -File |
        Sort-Object Name |
        ForEach-Object { (Get-FileHash $_.FullName -Algorithm SHA1).Hash }) -join "|"
} else { "" }

$env:SQLUSER     = $cred.UserName
$env:SQLPASSWORD = $cred.GetNetworkCredential().Password
# Unbuffered (-u / PYTHONUNBUFFERED): stream each line to the log as it happens.
# Python block-buffers stdout when piped, so without this a process killed
# mid-run (e.g. the 30-min Task Scheduler limit) flushes nothing and the log
# shows only the start line — exactly the blind spot we hit before. With it,
# the log records the last step reached, so a future hang is diagnosable.
$env:PYTHONUNBUFFERED = "1"
# Same stderr caveat as the build/git sections: under EAP=Stop, 2>&1 turns the
# first stderr line (e.g. line 1 of a python traceback) into a terminating
# error, killing the pipeline before anything is logged. Drop to Continue so
# the full traceback lands in refresh.log and judge by exit code.
$prevExportEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    python -u export-data.py --auth env 2>&1 | ForEach-Object { Add-Content -Path $logFile -Value "$_" -Encoding utf8; "$_" } | Out-Host
    $py = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $prevExportEAP
    Remove-Item Env:\SQLUSER         -ErrorAction SilentlyContinue
    Remove-Item Env:\SQLPASSWORD     -ErrorAction SilentlyContinue
    Remove-Item Env:\PYTHONUNBUFFERED -ErrorAction SilentlyContinue
}

if ($py -ne 0) {
    Write-Log "FAIL export-data.py exited $py"
    exit $py
}

# Shadow market rebuild needs the manually-downloaded CoStar export. When it
# is absent, skip the step and keep the existing shadow-market assets instead
# of aborting the whole refresh (which would also skip the git push below).
$costarSource = $env:COSTAR_CSV_PATH
if ([string]::IsNullOrWhiteSpace($costarSource)) {
    $costarSource = Join-Path (Split-Path $PSScriptRoot -Parent) "CoStarProperties.csv"
}
if (Test-Path $costarSource) {
    python -u shadow_market/build_configs.py 2>&1 | ForEach-Object { Add-Content -Path $logFile -Value $_ -Encoding utf8; $_ } | Out-Host
    $shadowConfigPy = $LASTEXITCODE
    if ($shadowConfigPy -ne 0) {
        Write-Log "FAIL shadow_market/build_configs.py exited $shadowConfigPy"
        exit $shadowConfigPy
    }

    python -u shadow_market/generate.py 2>&1 | ForEach-Object { Add-Content -Path $logFile -Value $_ -Encoding utf8; $_ } | Out-Host
    $shadowPy = $LASTEXITCODE
    if ($shadowPy -ne 0) {
        Write-Log "FAIL shadow_market/generate.py exited $shadowPy"
        exit $shadowPy
    }
} else {
    Write-Log "CoStar CSV not found ($costarSource); preserving existing shadow-market assets"
}

$studentMigrationSource = $env:STUDENT_MIGRATION_CSV_PATH
if ([string]::IsNullOrWhiteSpace($studentMigrationSource)) {
    $studentMigrationSource = Join-Path (Split-Path $PSScriptRoot -Parent) "MigrationOnly.csv"
}
if (Test-Path $studentMigrationSource) {
    python -u student_migration/generate.py --source $studentMigrationSource 2>&1 |
        ForEach-Object { Add-Content -Path $logFile -Value $_ -Encoding utf8; $_ } |
        Out-Host
    $studentMigrationPy = $LASTEXITCODE
    if ($studentMigrationPy -ne 0) {
        Write-Log "FAIL student_migration/generate.py exited $studentMigrationPy"
        exit $studentMigrationPy
    }
} else {
    Write-Log "student migration source not found; preserving existing student-origin assets"
}

$dataAfter = if (Test-Path "data.json") { (Get-FileHash data.json -Algorithm SHA1).Hash } else { "" }
$shadowAfter = if (Test-Path "assets\shadow-market") {
    (Get-ChildItem "assets\shadow-market" -Filter *.json -File |
        Sort-Object Name |
        ForEach-Object { (Get-FileHash $_.FullName -Algorithm SHA1).Hash }) -join "|"
} else { "" }
$studentMigrationAfter = if (Test-Path "assets\student-origin") {
    (Get-ChildItem "assets\student-origin" -Filter *.json -File |
        Sort-Object Name |
        ForEach-Object { (Get-FileHash $_.FullName -Algorithm SHA1).Hash }) -join "|"
} else { "" }
$dataChanged = $dataBefore -ne $dataAfter
$shadowChanged = $shadowBefore -ne $shadowAfter
$studentMigrationChanged = $studentMigrationBefore -ne $studentMigrationAfter
$changed = $dataChanged -or $shadowChanged -or $studentMigrationChanged
Write-Log "export complete (data.json changed: $dataChanged; shadow-market changed: $shadowChanged; student-migration changed: $studentMigrationChanged)"

if (-not $changed) {
    Write-Log "no change; skipping commit"
    Write-Log "=== weekly-refresh done ==="
    exit 0
}

if (-not $Push) {
    Write-Log "local refresh only (-Push not set); skipping git"
    Write-Log "=== weekly-refresh done ==="
    exit 0
}

# Stage *everything* in the dashboard folder so the live site mirrors local.
# .gitignore excludes .sql-cred.xml and refresh.log; double-check below.
# Caveat: any work-in-progress edits sitting in the tree at run time will
# get published. Don't leave broken HTML/JS in the working tree Sunday night.
# git writes normal status (e.g. "To <url> ... main -> main") to stderr, so we
# must NOT let stderr alone signal failure. Under $ErrorActionPreference="Stop"
# a 2>&1 redirect would turn that benign chatter into a terminating error and
# mislabel every successful push as failed. So we drop to "Continue" for the
# native git calls and judge success strictly by $LASTEXITCODE.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    git add -A 2>&1 | Out-Null

    # Defense in depth: if anything that looks like a secret somehow slipped
    # past .gitignore, bail before committing rather than push it publicly.
    $staged = git diff --cached --name-only
    $bad = $staged | Where-Object { $_ -match '\.sql-cred\.xml$|refresh\.log(\.\d+)?$|^\.env$|\.env\.local$' }
    if ($bad) {
        Write-Log "ABORT: secret-looking files were staged: $($bad -join ', ')"
        git reset 2>&1 | Out-Null
        $ErrorActionPreference = $prevEAP
        exit 3
    }

    if (-not $staged) {
        Write-Log "nothing to commit after staging"
        Write-Log "=== weekly-refresh done ==="
        $ErrorActionPreference = $prevEAP
        exit 0
    }

    $stamp = Get-Date -Format "yyyy-MM-dd"
    $fileCount = ($staged | Measure-Object).Count

    git commit -m "weekly refresh $stamp ($fileCount files)" 2>&1 | ForEach-Object { Add-Content -Path $logFile -Value "git: $_" -Encoding utf8 }
    if ($LASTEXITCODE -ne 0) { Write-Log "git commit FAILED (exit $LASTEXITCODE); local data.json is still fresh"; $ErrorActionPreference = $prevEAP; exit 4 }

    git push origin main 2>&1 | ForEach-Object { Write-Log "git: $_" }
    if ($LASTEXITCODE -ne 0) { Write-Log "git push FAILED (exit $LASTEXITCODE); commit is local-only, retry next run"; $ErrorActionPreference = $prevEAP; exit 5 }

    Write-Log "git push complete ($fileCount files)"
} catch {
    Write-Log "git step FAILED: $($_.Exception.Message) (local data.json is still fresh)"
} finally {
    $ErrorActionPreference = $prevEAP
}

Write-Log "=== weekly-refresh done ==="
