# vps-bot-autosync.ps1
# 用途：VPS 端拉取 GitHub 最新代码，若 bot-worker 相关文件有变化则自动重启 bot-worker。
# 注册后（每 5 分钟跑一次），本机改完 he-git 并 push 到 GitHub master，VPS 无需人工干预即生效。
#
# 注册（VPS 上管理员 PowerShell 执行一次）：
#   schtasks /Create /TN "harvests-bot-autosync" /TR "powershell -ExecutionPolicy Bypass -File C:\harvests\harvests-engine\scripts\vps-bot-autosync.ps1" /SC MINUTE /MO 5 /RL HIGHEST /F
# 查看： schtasks /Query /TN "harvests-bot-autosync" /V /FO LIST
# 移除： schtasks /Delete /TN "harvests-bot-autosync" /F

$ErrorActionPreference = 'Continue'
$repo     = 'C:\harvests\harvests-engine'
$logDir   = 'C:\harvests\logs'
$logFile  = Join-Path $logDir 'vps-autosync.log'
$branch   = 'master'
# 这些文件变了才重启 bot-worker（避免改个 README 也重启）
$watch    = @('scripts/bot-worker-real.ts','scripts/comment-generator.ts','scripts/vision-analyze.ts','ecosystem.config.cjs')

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
function Log($msg) {
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

$statusFile      = Join-Path $logDir 'autosync-status.json'
$script:afterHead  = ''
$script:remoteHead = ''

# Machine-readable outcome, for the front-end "system health" board: bot-worker reads
# this file on every heartbeat and ships it to /api/system/health, where a stale or
# failed autosync turns a block red. Log-only reporting is what let a broken autosync
# look like an idle one for weeks.
#
# ASCII-only notes and UTF8 WITHOUT BOM - the bot does JSON.parse() on this file.
function Write-Status([string]$result, [string]$note, [bool]$restarted) {
  try {
    $h = ''
    if ($script:afterHead)  { $h  = $script:afterHead.Substring(0, [Math]::Min(12, $script:afterHead.Length)) }
    $rh = ''
    if ($script:remoteHead) { $rh = $script:remoteHead.Substring(0, [Math]::Min(12, $script:remoteHead.Length)) }
    $obj = [ordered]@{
      at         = [int64](([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalMilliseconds)
      result     = $result
      note       = $note
      head       = $h
      remoteHead = $rh
      restarted  = $restarted
    }
    $json = ($obj | ConvertTo-Json -Compress)
    [System.IO.File]::WriteAllText($statusFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch {}
}

# A scheduled task starts with a minimal environment where npm's global bin dir
# (%APPDATA%\npm) is often missing from PATH. A bare `pm2` then does nothing at all,
# and piping it to Out-Null hides that completely. Resolve it explicitly.
function Resolve-Pm2 {
  $cmd = Get-Command pm2 -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($c in @(
    (Join-Path $env:APPDATA 'npm\pm2.cmd'),
    (Join-Path $env:ProgramFiles 'nodejs\pm2.cmd'),
    'C:\Program Files\nodejs\pm2.cmd'
  )) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

try {
  Set-Location $repo
  $before = git rev-parse HEAD 2>$null
  if (-not $before) { Log "ERROR: not a git repo at $repo"; exit 1 }

  # fast-forward only, so VPS-local edits cannot conflict (a failure is now explicit - see below)
  $pull = git pull --ff-only origin $branch 2>&1
  $pullTxt = ($pull | Out-String).Trim()
  $after = git rev-parse HEAD 2>$null
  $script:afterHead  = $after
  $script:remoteHead = (git rev-parse "origin/$branch" 2>$null)

  # 2026-09-18: this used to Log "no-change" and return. But a FAILED pull leaves HEAD
  # unchanged too, so a permanently broken autosync was indistinguishable in the log from
  # a healthy idle one, and $pullTxt (the actual error) was only printed when HEAD moved.
  # That is the same false-green-light class as the CDP probe reporting a freeze on a
  # healthy Chrome. Judge failure first, then no-change.
  if ($before -eq $after) {
    if ($pullTxt -match '(?i)fatal|error:|conflict|would be overwritten|rejected|not possible to fast-forward|cannot pull') {
      Log "PULL FAILED (HEAD still $($after.Substring(0,7)))"
      Log "pull: $($pullTxt -replace '\r?\n',' | ')"
      Log "HINT: local edits on the VPS block --ff-only. Inspect with: git status --short ; git stash -- <file>"
      Write-Status 'pull-failed' 'git pull --ff-only failed - local edits probably block it (see vps-autosync.log)' $false
      exit 1
    }
    Log "no-change HEAD=$($after.Substring(0,7))"
    Write-Status 'no-change' 'already up to date' $false
    exit 0
  }

  Log "updated $($before.Substring(0,7)) -> $($after.Substring(0,7))"
  Log "pull: $($pullTxt -replace '\r?\n',' | ')"

  $changed = git diff --name-only $before $after 2>$null
  $hit = @($changed | Where-Object { $watch -contains $_ })
  if ($hit.Count -eq 0) {
    Log "no watched file changed -> skip restart ($(($changed -join ', ')))"
    Write-Status 'updated' "pulled to $($after.Substring(0,7)); no watched file changed, no restart" $false
    exit 0
  }
  Log "watched changed: $($hit -join ', ') -> restarting bot-worker"

  # A scheduled task gets a minimal environment where npm's global bin dir is often
  # missing from PATH, so a bare `pm2` would silently do nothing - swallowed by Out-Null.
  # Code would be pulled but the bot never restarted, again looking like "no change".
  $pm2 = Resolve-Pm2
  if (-not $pm2) {
    Log "ERROR: pm2 not found on PATH - code was updated but bot-worker was NOT restarted"
    Write-Status 'error' 'pm2 not found on PATH - code pulled but bot-worker NOT restarted' $false
    exit 1
  }
  & $pm2 delete bot-worker 2>&1 | Out-Null
  & $pm2 start ecosystem.config.cjs --only bot-worker 2>&1 | Out-Null
  & $pm2 save 2>&1 | Out-Null          # otherwise a reboot loses this entry from dump.pm2
  Start-Sleep -Seconds 25
  $tail = Get-Content 'C:\harvests\logs\bot-worker-out.log' -Tail 6 -ErrorAction SilentlyContinue
  Log "restarted: $(($tail -join ' || '))"
  Write-Status 'updated' "pulled to $($after.Substring(0,7)) and restarted bot-worker ($($hit -join ', '))" $true
} catch {
  Log "EXCEPTION: $($_.Exception.Message)"
  Write-Status 'error' ("exception: " + $_.Exception.Message) $false
}
