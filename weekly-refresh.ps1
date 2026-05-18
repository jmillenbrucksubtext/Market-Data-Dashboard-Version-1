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
    [switch]$Push   # opt-in: also commit + push to origin/main after refresh
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

try {
    git add data.json plans/ 2>&1 | Out-Null
    $stamp = Get-Date -Format "yyyy-MM-dd"
    git commit -m "weekly data refresh $stamp" 2>&1 | Out-Null
    git push origin main 2>&1 | ForEach-Object { Write-Log "git: $_" }
    Write-Log "git push complete"
} catch {
    Write-Log "git step FAILED: $($_.Exception.Message) (local data.json is still fresh)"
}

Write-Log "=== weekly-refresh done ==="
