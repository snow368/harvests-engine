<#
  chrome-keeper.ps1 - keep the shared 9222 Chrome alive on the VPS.

  WHY THIS EXISTS (2026-09-18 incident):
    bot-worker depends on a Chrome window that NOTHING supervises.
    - pm2 owns bot-worker, but Chrome is a plain GUI process: no pm2 entry,
      no service, no watchdog (repair-bot-runner.ps1 step 3 deliberately kills
      every ig-watchdog / cdp-probe / start-bots task, which left this hole).
    - When that Chrome dies (crash, machine reboot, RDP logoff), bot-worker parks
      on `cdp_unreachable(...) -> fetch failed`. bootstrap() retries in place
      forever and NEVER exits, so pm2 restart count stays flat and the dashboard
      keeps showing a green light. Symptom = bot online, zero output, zero
      behavior events, zero task leases, and this single line in the out log:
          browser ensure attempt 1/3 failed: cdp_unreachable(...) -> fetch failed

  SCOPE - deliberately narrow:
    * It only manages Chrome.
    * It does NOT pm2 delete anything. pm2 owns bot-worker's lifetime.
    * After a Chrome recovery it calls `pm2 restart bot-worker --update-env` so the
      bot re-attaches cleanly to the new browser (disable with -NoBotRestart).

  USAGE (VPS, Administrator PowerShell):
    cd C:\harvests\harvests-engine
    # 1) dry run first - reports state, changes nothing
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\chrome-keeper.ps1 -DryRun
    # 2) one-shot check + heal (what the scheduled task runs)
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\chrome-keeper.ps1
    # 3) resident loop, every 2 minutes
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\chrome-keeper.ps1 -Loop

  Register as a scheduled task (every 5 minutes, survives RDP disconnect):
    schtasks /create /tn "harvests-chrome-keeper" /sc minute /mo 5 /rl highest /f ^
      /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\harvests\harvests-engine\scripts\chrome-keeper.ps1"

  ASCII-only on purpose: Windows PowerShell 5.1 garbles non-ASCII .ps1 files
  written without a BOM.
#>
param(
  [switch]$DryRun,          # report only, change nothing (run this first)
  [switch]$Loop,
  [switch]$NoBotRestart,
  [int]$IntervalSeconds = 120
)

$ErrorActionPreference = 'Continue'

$EngineDir  = 'C:\harvests\harvests-engine'
$ChromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$ProfileDir = 'C:\harvests\profiles\bot_ig_01'
$CdpPort    = 9222
$ProbeScript = Join-Path $PSScriptRoot 'cdp-probe.cjs'
$LogDir     = 'C:\harvests\logs'
$LogPath    = Join-Path $LogDir 'chrome-keeper.log'
$CdpBase    = "http://localhost:$CdpPort"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Log([string]$m) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"
  Write-Host $line
  try {
    Add-Content -Path $LogPath -Value $line
    # keep the log from growing forever
    $all = @(Get-Content $LogPath -ErrorAction SilentlyContinue)
    if ($all.Count -gt 2000) { $all[-1000..-1] | Set-Content -Path $LogPath }
  } catch {}
}

function Test-CdpPort {
  try {
    $null = Invoke-RestMethod "$CdpBase/json/version" -TimeoutSec 3
    return $true
  } catch { return $false }
}

# HTTP reachable != protocol alive. See ig-watchdog.ps1 header for the full story:
# Chrome can keep answering /json/version while its main thread is frozen, which
# makes connectOverCDP hang until timeout.
# Returns 'ok' | 'frozen' | 'unknown'
function Test-CdpProtocol {
  if (Test-Path $ProbeScript) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
      & node $ProbeScript 2>$null
      switch ($LASTEXITCODE) {
        1 { return 'frozen' }
        0 { return 'ok' }
        2 { return 'unknown' }
        default { return 'unknown' }
      }
    }
  }
  # Fallback: inline browser-level WS probe (Browser.getVersion, 5s budget).
  try {
    $wsUrl = (Invoke-RestMethod "$CdpBase/json/version" -TimeoutSec 3).webSocketDebuggerUrl
    if (-not $wsUrl) { return 'unknown' }
    $ws  = New-Object System.Net.WebSockets.ClientWebSocket
    $cts = [System.Threading.CancellationTokenSource]::new()
    $cts.CancelAfter(5000)
    $ws.ConnectAsync([Uri]$wsUrl, $cts.Token).Wait(6000) | Out-Null
    if ($ws.State -ne 'Open') { try { $ws.Dispose() } catch {}; return 'frozen' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes('{"id":1,"method":"Browser.getVersion"}')
    $seg   = [ArraySegment[byte]]::new($bytes)
    $ws.SendAsync($seg, 'Text', $true, $cts.Token).Wait(3000) | Out-Null
    $buf   = New-Object byte[] 4096
    $rseg  = [ArraySegment[byte]]::new($buf)
    $recv  = $ws.ReceiveAsync($rseg, $cts.Token)
    $got = $false
    if ($recv.Wait(6000)) {
      $txt = [System.Text.Encoding]::UTF8.GetString($buf, 0, $recv.Result.Count)
      if ($txt -match '"id"\s*:\s*1') { $got = $true }
    }
    try { $ws.Dispose() } catch {}
    if ($got) { return 'ok' } else { return 'frozen' }
  } catch { return 'unknown' }
}

function Stop-AllChrome {
  $procs = @(Get-Process chrome -ErrorAction SilentlyContinue)
  if ($procs.Count -gt 0) {
    Log "  killing $($procs.Count) chrome process(es)"
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
  }
}

function Start-CleanChrome {
  if (-not (Test-Path $ChromePath)) {
    Log "  !! chrome.exe not found at $ChromePath - fix `$ChromePath in this script"
    return $false
  }
  # Chrome restores the previous session on relaunch: one dead tab target is enough
  # to make connectOverCDP hang on attach. Kill the restore files first so the new
  # window always comes up with exactly the single IG tab the bot needs.
  foreach ($f in @('Current Session', 'Current Tabs', 'Last Session', 'Last Tabs')) {
    Remove-Item (Join-Path $ProfileDir "Default\$f") -Force -ErrorAction SilentlyContinue
  }
  Remove-Item (Join-Path $ProfileDir 'Default\Sessions') -Recurse -Force -ErrorAction SilentlyContinue

  Start-Process $ChromePath -ArgumentList @(
    "--remote-debugging-port=$CdpPort",
    '--remote-allow-origins=*',
    "--user-data-dir=$ProfileDir",
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--new-window',
    'https://www.instagram.com'
  )
  Log "  chrome launched (profile=$ProfileDir, cdp=$CdpPort)"

  # wait for the port (max 30s)
  $up = $false
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 2
    if (Test-CdpPort) { $up = $true; break }
  }
  if (-not $up) { Log '  !! CDP did not come up within 30s'; return $false }
  try { Log "  CDP up: $((Invoke-RestMethod "$CdpBase/json/version" -TimeoutSec 3).Browser)" } catch {}

  # wait for the protocol (a brand new Chrome can still be busy restoring)
  for ($i = 0; $i -lt 6; $i++) {
    if ((Test-CdpProtocol) -ne 'frozen') { break }
    Start-Sleep -Seconds 5
  }
  return $true
}

function Compress-CdpTabs {
  try {
    $list  = @(Invoke-RestMethod "$CdpBase/json/list" -TimeoutSec 3)
    $pages = @($list | Where-Object { $_.type -eq 'page' })
    if ($pages.Count -le 1) { return }
    $keep = $pages | Where-Object { $_.url -like '*instagram.com*' } | Select-Object -First 1
    if (-not $keep) { $keep = $pages[0] }
    $n = 0
    foreach ($p in $pages) {
      if ($p.id -ne $keep.id) {
        try { Invoke-RestMethod "$CdpBase/json/close/$($p.id)" -TimeoutSec 3 | Out-Null; $n++ } catch {}
      }
    }
    Log "  closed $n extra tab(s), kept: $($keep.url)"
  } catch {}
}

function Restart-Bot {
  if ($NoBotRestart) { Log '  (-NoBotRestart: skipping pm2 restart)'; return }
  $desc = (& pm2 describe bot-worker 2>&1 | Out-String)
  if ($desc -match '(?i)not found|does not exist') {
    Log '  bot-worker not in pm2 - starting it'
    Push-Location $EngineDir
    & pm2 start ecosystem.config.cjs --only bot-worker --update-env 2>&1 | Out-Null
    & pm2 save 2>$null | Out-Null
    Pop-Location
    return
  }
  # restart (not delete+start): keeps the pm2 entry and its env, and the bump in the
  # restart counter is a visible signal that a real reload happened.
  Push-Location $EngineDir
  & pm2 restart bot-worker --update-env 2>&1 | Out-Null
  Pop-Location
  Log '  pm2 restart bot-worker --update-env done (bot re-attaches to the new browser)'
}

function Invoke-KeeperPass {
  $portUp = Test-CdpPort
  if ($DryRun) {
    if (-not $portUp) { Log '[DRYRUN] CDP port 9222 is DOWN - a real run would restart Chrome and restart bot-worker.'; return }
    $p = Test-CdpProtocol
    Log "[DRYRUN] CDP port is up; protocol = $p - no action taken."
    return
  }
  if (-not $portUp) {
    Log '[ALERT] CDP port 9222 down -> nothing is listening. Restarting Chrome.'
    Stop-AllChrome
    if (Start-CleanChrome) {
      Compress-CdpTabs
      Restart-Bot
      Log '[FIXED] Chrome is back and reachable.'
    } else {
      Log '[FAIL] Chrome restart did not produce a reachable CDP port - check the Chrome window manually.'
    }
    return
  }

  $proto = Test-CdpProtocol
  if ($proto -eq 'frozen') {
    Log '[ALERT] CDP protocol FROZEN (port answers, commands do not) -> restarting Chrome.'
    Stop-AllChrome
    if (Start-CleanChrome) {
      Compress-CdpTabs
      Restart-Bot
      Log '[FIXED] Chrome replaced and protocol responsive.'
    } else {
      Log '[FAIL] Chrome restart did not clear the freeze - close the Chrome window by hand and rerun.'
    }
    return
  }
  if ($proto -eq 'unknown') {
    Log '[WARN] protocol probe unavailable (no cdp-probe.cjs / node) - port check only.'
  } else {
    Log '[OK] Chrome CDP healthy (port + protocol).'
  }
}

if ($Loop) {
  Log "chrome-keeper started in loop mode (every ${IntervalSeconds}s)"
  while ($true) {
    try { Invoke-KeeperPass } catch { Log "pass error: $($_.Exception.Message)" }
    Start-Sleep -Seconds $IntervalSeconds
  }
} else {
  try { Invoke-KeeperPass } catch { Log "pass error: $($_.Exception.Message)" }
}
