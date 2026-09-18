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
    * It will NOT kill Chrome on a 'frozen' verdict alone. A restart additionally
      requires the bot's out log to be stale by $BotLogStaleMin, because the probe
      once reported 'frozen' while the bot was demonstrably still liking posts.

  USAGE (VPS, Administrator PowerShell):
    cd C:\harvests\harvests-engine
    # 1) dry run first - reports state, changes nothing
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\chrome-keeper.ps1 -DryRun
    # 2) one-shot check + heal (what the scheduled task runs)
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\chrome-keeper.ps1
    # 3) resident loop, every 2 minutes
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\chrome-keeper.ps1 -Loop

  What a healthy dry run looks like:
    [DRYRUN] CDP port is up; protocol = ok; bot-worker-out.log age = 0.3 min.
    [DRYRUN] -> nothing to do.
  If it prints `protocol = frozen` together with a fresh log age, that is the known
  false positive and no action is taken - run `node scripts\cdp-probe.cjs` by hand to
  see the real reason on stderr.

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
$BotOutLog  = 'C:\harvests\logs\bot-worker-out.log'
# A "frozen" verdict alone is not enough to justify killing Chrome.
# Reasoning (verified against bot-worker-real.ts): neither heartbeatBot nor pollLoop
# writes to this log on a normal cycle, so a genuinely frozen browser means the bot's
# CDP calls hang and nothing gets written at all -> the log goes stale, which is
# exactly when action is allowed. A log touched recently means CDP commands are still
# completing, i.e. the browser is NOT frozen. See the false-positive incident in
# Test-CdpProtocol's header.
$BotLogStaleMin = 10

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

# Age in minutes of the bot's out log; -1 when the file does not exist.
# Used as the corroborating signal for a 'frozen' verdict - never kill Chrome on the
# probe's word alone.
function Get-BotLogAgeMin {
  if (-not (Test-Path $BotOutLog)) { return -1 }
  return [math]::Round(((Get-Date) - (Get-Item $BotOutLog).LastWriteTime).TotalMinutes, 1)
}

# HTTP reachable != protocol alive. See the cdp-probe.cjs header for the full story:
# Chrome can keep answering /json/version while its main thread is frozen, which
# makes connectOverCDP hang until timeout.
# Returns 'ok' | 'frozen' | 'unknown'
#
# Exit codes from cdp-probe.cjs v2:
#   0 = healthy | 1 = frozen | 2 = no global WebSocket (node too old) | 3 = probe itself failed
# 2 and 3 mean "we could not tell" - NEVER treat them as a freeze. v1 conflated
# "handshake ok but no reply" with "ws.on('error')" under exit 1, and that false
# 'frozen' would have made this keeper kill a perfectly healthy Chrome every pass.
function Test-CdpProtocol {
  if (Test-Path $ProbeScript) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
      $probeOut = ''
      try { $probeOut = (& node $ProbeScript 2>&1 | Out-String).Trim() } catch {}
      $rc = $LASTEXITCODE
      if ($rc -eq 0) { return 'ok' }
      if ($rc -eq 1) { return 'frozen' }
      if ($probeOut) { Log "  (probe rc=$rc detail: $($probeOut -replace '\s+', ' '))" }
      return 'unknown'
    }
    Log '  (node not on PATH - falling back to the inline websocket probe)'
  } else {
    Log "  (cdp-probe.cjs not found at $ProbeScript - using the inline websocket probe)"
  }
  # Fallback: inline browser-level WS probe (Browser.getVersion, 5s budget).
  try {
    $wsUrl = (Invoke-RestMethod "$CdpBase/json/version" -TimeoutSec 3).webSocketDebuggerUrl
    if (-not $wsUrl) { return 'unknown' }
    $ws  = New-Object System.Net.WebSockets.ClientWebSocket
    $cts = [System.Threading.CancellationTokenSource]::new()
    $cts.CancelAfter(5000)
    # A failed/timed-out connect is "cannot tell", NOT a freeze - the old code returned
    # 'frozen' here and that is how a healthy Chrome got killed.
    $connected = $false
    try { $connected = $ws.ConnectAsync([Uri]$wsUrl, $cts.Token).Wait(6000) } catch { $connected = $false }
    if (-not $connected -or $ws.State -ne 'Open') {
      try { $ws.Dispose() } catch {}
      return 'unknown'
    }
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

# A scheduled task starts with a minimal environment: npm's global bin dir
# (%APPDATA%\npm) is often absent from PATH, so a bare `pm2` silently does nothing
# and only Chrome gets fixed - the bot never re-attaches. Resolve it explicitly.
function Resolve-Pm2 {
  $cmd = Get-Command pm2 -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:APPDATA 'npm\pm2.cmd'),
    (Join-Path $env:ProgramFiles 'nodejs\pm2.cmd'),
    'C:\Program Files\nodejs\pm2.cmd'
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

function Restart-Bot {
  if ($NoBotRestart) { Log '  (-NoBotRestart: skipping pm2 restart)'; return }
  $pm2 = Resolve-Pm2
  if (-not $pm2) {
    Log '  !! pm2 not found on PATH - Chrome is fixed but the bot was NOT restarted.'
    Log '     Fix: run the pm2 step by hand, or add %APPDATA%\npm to the machine PATH.'
    return
  }
  $desc = (& $pm2 describe bot-worker 2>&1 | Out-String)
  if ($desc -match '(?i)not found|does not exist') {
    Log '  bot-worker not in pm2 - starting it'
    Push-Location $EngineDir
    & $pm2 start ecosystem.config.cjs --only bot-worker --update-env 2>&1 | Out-Null
    & $pm2 save 2>$null | Out-Null
    Pop-Location
    return
  }
  # restart (not delete+start): keeps the pm2 entry and its env, and the bump in the
  # restart counter is a visible signal that a real reload happened.
  Push-Location $EngineDir
  & $pm2 restart bot-worker --update-env 2>&1 | Out-Null
  Pop-Location
  Log '  pm2 restart bot-worker --update-env done (bot re-attaches to the new browser)'
}

function Invoke-KeeperPass {
  $portUp = Test-CdpPort
  if ($DryRun) {
    if (-not $portUp) { Log '[DRYRUN] CDP port 9222 is DOWN - a real run would restart Chrome and restart bot-worker.'; return }
    $p   = Test-CdpProtocol
    $age = Get-BotLogAgeMin
    Log "[DRYRUN] CDP port is up; protocol = $p; bot-worker-out.log age = $age min."
    if ($p -eq 'frozen' -and $age -ge 0 -and $age -lt $BotLogStaleMin) {
      Log '[DRYRUN] -> a real run would NOT act: the bot log is fresh, so the freeze verdict is a FALSE POSITIVE.'
    } elseif ($p -eq 'frozen') {
      Log '[DRYRUN] -> a real run WOULD restart Chrome (probe says frozen AND the bot log is stale).'
    } elseif ($p -eq 'unknown') {
      Log '[DRYRUN] -> a real run would NOT act: the probe could not tell (rc=2/3 is not a freeze).'
    } else {
      Log '[DRYRUN] -> nothing to do.'
    }
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
    # Corroborate before killing anything. 2026-09-18: the probe reported 'frozen' at
    # 05:04:33 UTC while the bot logged like_post x5 at 05:04:55 - the browser was fine
    # and acting on the probe alone would have restarted Chrome every 5 minutes.
    $age = Get-BotLogAgeMin
    if ($age -lt 0) {
      Log '[WARN] probe says FROZEN but bot-worker-out.log is missing - cannot corroborate. NOT restarting.'
      return
    }
    if ($age -lt $BotLogStaleMin) {
      Log "[WARN] probe says FROZEN but bot-worker-out.log was written $age min ago -> the bot is still working, this is a FALSE POSITIVE. Not touching Chrome."
      Log '       If this repeats every pass, the probe itself is broken: run `node scripts\cdp-probe.cjs` by hand and read stderr.'
      return
    }
    Log "[ALERT] CDP protocol FROZEN (port answers, commands do not; bot log silent for $age min) -> restarting Chrome."
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
    Log '[WARN] protocol probe unavailable or inconclusive (probe rc=2/3) - port check only, no action.'
  } else {
    Log "[OK] Chrome CDP healthy (port + protocol). bot log age = $(Get-BotLogAgeMin) min."
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
