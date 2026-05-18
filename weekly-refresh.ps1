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

$dataBefore = if (Test-Path "data.json") { (Get-FileHash data.json -Algorithm SHA1).Hash } else { "" }

$env:SQLUSER     = $cred.UserName
$env:SQLPASSWORD = $cred.GetNetworkCredential().Password
try {
    python export-data.py --auth env 2>&1 | ForEach-Object { Add-Content -Path $logFile -Value $_ -Encoding utf8; $_ } | Out-Host
    $py = $LASTEXITCODE
} finally {
    Remove-Item Env:\SQLUSER     -ErrorAction SilentlyContinue
    Remove-Item Env:\SQLPASSWORD -ErrorAction SilentlyContinue
}

if ($py -ne 0) {
    Write-Log "FAIL export-data.py exited $py"
    exit $py
}

$dataAfter = if (Test-Path "data.json") { (Get-FileHash data.json -Algorithm SHA1).Hash } else { "" }
$changed = $dataBefore -ne $dataAfter
Write-Log "export complete (data.json changed: $changed)"

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
try {
    git add -A 2>&1 | Out-Null

    # Defense in depth: if anything that looks like a secret somehow slipped
    # past .gitignore, bail before committing rather than push it publicly.
    $staged = git diff --cached --name-only
    $bad = $staged | Where-Object { $_ -match '\.sql-cred\.xml$|refresh\.log(\.\d+)?$|^\.env$|\.env\.local$' }
    if ($bad) {
        Write-Log "ABORT: secret-looking files were staged: $($bad -join ', ')"
        git reset 2>&1 | Out-Null
        exit 3
    }

    if (-not $staged) {
        Write-Log "nothing to commit after staging"
        Write-Log "=== weekly-refresh done ==="
        exit 0
    }

    $stamp = Get-Date -Format "yyyy-MM-dd"
    $fileCount = ($staged | Measure-Object).Count
    git commit -m "weekly refresh $stamp ($fileCount files)" 2>&1 | Out-Null
    git push origin main 2>&1 | ForEach-Object { Write-Log "git: $_" }
    Write-Log "git push complete ($fileCount files)"
} catch {
    Write-Log "git step FAILED: $($_.Exception.Message) (local data.json is still fresh)"
}

Write-Log "=== weekly-refresh done ==="
