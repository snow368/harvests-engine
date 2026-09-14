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

try {
  Set-Location $repo
  $before = git rev-parse HEAD 2>$null
  if (-not $before) { Log "ERROR: not a git repo at $repo"; exit 1 }

  # 只 fast-forward，避免与 VPS 本地改动冲突（有冲突会 pull 失败并在日志留痕）
  $pull = git pull --ff-only origin $branch 2>&1
  $pullTxt = ($pull | Out-String).Trim()
  $after = git rev-parse HEAD 2>$null

  if ($before -eq $after) { Log "no-change HEAD=$($after.Substring(0,7))"; exit 0 }

  Log "updated $($before.Substring(0,7)) -> $($after.Substring(0,7))"
  Log "pull: $($pullTxt -replace '\r?\n',' | ')"

  $changed = git diff --name-only $before $after 2>$null
  $hit = @($changed | Where-Object { $watch -contains $_ })
  if ($hit.Count -eq 0) {
    Log "no watched file changed -> skip restart ($(($changed -join ', ')))"
    exit 0
  }
  Log "watched changed: $($hit -join ', ') -> restarting bot-worker"

  pm2 delete bot-worker 2>&1 | Out-Null
  pm2 start ecosystem.config.cjs --only bot-worker 2>&1 | Out-Null
  Start-Sleep -Seconds 25
  $tail = Get-Content 'C:\harvests\logs\bot-worker-out.log' -Tail 6 -ErrorAction SilentlyContinue
  Log "restarted: $(($tail -join ' || '))"
} catch {
  Log "EXCEPTION: $($_.Exception.Message)"
}
