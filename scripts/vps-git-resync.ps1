# vps-git-resync.ps1
# One-shot repair for the VPS repo: revert local edits (created by earlier raw
# file downloads), fast-forward to GitHub master, restore the locally tuned
# ecosystem.config.cjs (BOT_* env values), then restart bot-worker.
#
# Usage (admin PowerShell on VPS):
#   powershell -ExecutionPolicy Bypass -File C:\harvests\harvests-engine\scripts\vps-git-resync.ps1

$ErrorActionPreference = 'Continue'
$repo   = 'C:\harvests\harvests-engine'
$backup = 'C:\harvests\local-backup'

if (-not (Test-Path $backup)) { New-Item -ItemType Directory -Path $backup -Force | Out-Null }
Set-Location $repo
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'

Write-Host "===== STEP 1: local modifications ====="
$porcelain = @(git status --porcelain 2>$null)
if ($porcelain.Count -eq 0) {
  Write-Host "(working tree clean)"
} else {
  foreach ($line in $porcelain) {
    if ($line.Length -lt 4) { continue }
    $xy   = $line.Substring(0, 2)
    $path = $line.Substring(3).Trim().Trim('"')
    if ($xy -eq '??') { Write-Host "skip untracked: $path"; continue }
    $src = Join-Path $repo $path
    if (Test-Path $src) {
      $flat = ($path -replace '[\\/]', '_') + '.' + $ts
      Copy-Item $src (Join-Path $backup $flat) -Force -ErrorAction SilentlyContinue
      Write-Host "backed up -> C:\harvests\local-backup\$flat"
    }
    git checkout -- "$path" 2>&1 | Out-Null
    Write-Host "reverted: $path"
  }
}

Write-Host "===== STEP 2: fetch + fast-forward ====="
git fetch origin 2>&1 | Out-Null
$before = (git rev-parse HEAD 2>$null)
git pull --ff-only origin master 2>&1
$after = (git rev-parse HEAD 2>$null)
Write-Host "HEAD: $($before.Substring(0,7)) -> $($after.Substring(0,7))"

Write-Host "===== STEP 3: restore tuned ecosystem.config.cjs ====="
$eco = Get-ChildItem $backup -Filter "ecosystem.config.cjs.$ts" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($eco) {
  Copy-Item $eco.FullName (Join-Path $repo 'ecosystem.config.cjs') -Force
  git update-index --assume-unchanged ecosystem.config.cjs 2>&1 | Out-Null
  Write-Host "restored ecosystem.config.cjs from $($eco.Name) (and marked assume-unchanged)"
} else {
  Write-Host "no local ecosystem backup -> keeping repo version"
}

Write-Host "===== STEP 4: current BOT_ settings ====="
Select-String -Path (Join-Path $repo 'ecosystem.config.cjs') -Pattern 'BOT_DAILY_TASK_LIMIT|BOT_COMMENT_PUBLISH_DAILY_MAX|BOT_POLL_INTERVAL_MS|BOT_COMMENT_CHANCE|BOT_HOST|BOT_ID' |
  ForEach-Object { $_.Line.Trim() }

Write-Host "===== STEP 5: restart bot-worker ====="
pm2 delete bot-worker 2>&1 | Out-Null
Start-Sleep -Seconds 3
pm2 start ecosystem.config.cjs --only bot-worker 2>&1 | Out-Null
Start-Sleep -Seconds 25
Write-Host "--- pm2 list ---"
pm2 list 2>&1
Write-Host "--- bot-worker log tail ---"
Get-Content 'C:\harvests\logs\bot-worker-out.log' -Tail 12 -ErrorAction SilentlyContinue
Write-Host "===== DONE ====="
