<#
  fix-popup-windows.ps1 - stop Task Scheduler from flashing console windows on the VPS.

  WHY THIS EXISTS (2026-09-18, user report: a CMD window keeps popping up):
    A scheduled task whose action is a console program WITHOUT -WindowStyle Hidden
    gets a brand-new *visible* console window every single time it fires, in the
    interactive session. `harvests-bot-autosync` runs every 5 minutes = 288
    flashes per day. That is the entire popup story.

    It is NOT pm2: ForkMode.js launches apps with windowsHide: true.
    It is NOT the bot's own child processes: scripts/check-windows-hide.mjs
    audits every spawn/exec in the pm2-managed scripts and they all pass
    ("9 managed scripts, 5 call points, all carry windowsHide").

  WHAT IT DOES:
    * Enumerates every ENABLED scheduled task outside \Microsoft\ (built-ins are
      left alone). Nothing is ever deleted, nothing is ever created.
    * powershell.exe / pwsh.exe action missing -WindowStyle Hidden -> fixed in
      place by PREPENDING "-WindowStyle Hidden". PowerShell accepts its named
      parameters in any order, so this is behaviour-preserving.
      Applied via Set-ScheduledTask (never schtasks /TR), so quoting cannot be
      mangled; trigger / principal / settings are preserved untouched.
    * cmd / node / python actions -> reported as MANUAL and never guessed at,
      because rewriting the payload into another interpreter is a behaviour
      change. Opt in with -FixCmd to also convert `cmd /c "<one existing file>"`
      into a hidden PowerShell launcher (PowerShell's call operator still runs
      .bat/.cmd through cmd.exe, and -WorkingDirectory is carried over).
    * Idempotent: anything that already has -WindowStyle Hidden is skipped.

  USAGE (VPS, Administrator PowerShell):
    cd C:\harvests\harvests-engine
    # 0) prove the classifier itself (no scheduler access, changes nothing)
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-popup-windows.ps1 -SelfTest
    # 1) see the exact plan, change nothing
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-popup-windows.ps1 -DryRun
    # 2) apply, then read the built-in VERIFY table
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-popup-windows.ps1
    # 3) optional: also convert cmd /c "<file>" actions
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-popup-windows.ps1 -FixCmd

  Typical manual leftover:
    Task "InkFlow Bot Workers" -> cmd /c ...\start-bots.bat  (AtStartup only, so
    it costs one flash per boot, not 288/day). Rerun with -FixCmd, or rewrite the
    action yourself as a hidden PowerShell launcher for that path.

  ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI(936),
  where a UTF-8 Chinese comment can emit a trailing 0x60 (backtick) = line
  continuation, which swallows the next brace and breaks the file with
  "MissingCatchOrFinally". Keeping this file pure ASCII makes that impossible.
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  # Optional filter, e.g. -NameLike 'harvests*'. Default = every user task.
  [string]$NameLike = '*',
  # Also convert `cmd /c "<one existing file>"` into a hidden launcher. Opt-in.
  [switch]$FixCmd,
  # Run the classifier against built-in fixtures and exit. Touches nothing.
  [switch]$SelfTest
)

$ErrorActionPreference = 'Continue'

# --- classification rules -------------------------------------------------
# Note the `\b` instead of `$` in $otherRe: a task action is usually
#   cmd /c "C:\...\start-bots.bat"
# and the trailing quote made an anchored `\.bat$` test miss it, so a real
# popup source was silently reported as "nothing to do". Match the token.
$hideRe  = '-WindowStyle\s+Hidden'
$psExeRe = '(?i)(powershell|pwsh)(\.exe)?$'
$cmdExeRe = '(?i)^(.*\\)?cmd(\.exe)?$'
$otherRe = '(?i)\.(bat|cmd|ps1|vbs)\b|\b(node|python|pythonw|wscript|cscript|conhost)\b|\bpm2\b'

function Resolve-Action {
  param(
    [string]$Exe,
    [string]$Arg,
    [bool]$AllowCmd = $false
  )

  # kind: skip | fix | manual | ignore
  $r = @{ kind = 'ignore'; newExe = $Exe; newArgs = $Arg }

  if ([string]::IsNullOrEmpty($Exe)) { return $r }

  if ($Arg -match $hideRe) {
    $r.kind = 'skip'
    return $r
  }

  if ($Exe -match $psExeRe) {
    $r.kind = 'fix'
    $r.newArgs = '-WindowStyle Hidden ' + $Arg
    return $r
  }

  if (("$Exe $Arg") -notmatch $otherRe) { return $r }

  # Console program that is not PowerShell. Only convert when the whole payload
  # is a single path that actually exists - anything else is too ambiguous to
  # rewrite automatically.
  if ($AllowCmd -and ($Exe -match $cmdExeRe)) {
    $target = $null
    if ($Arg -match '^\s*/c\s+"?([^"]+?)"?\s*$') { $target = $matches[1] }
    if ($target -and (Test-Path -LiteralPath $target)) {
      $r.kind = 'fix'
      $r.newExe = 'powershell.exe'
      $r.newArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& ''' + $target + '''"'
      return $r
    }
  }

  $r.kind = 'manual'
  return $r
}

if ($SelfTest) {
  $batSample = 'C:\harvests\harvests-engine\start-bots.bat'
  $fixtures = @(
    @{ n = 'autosync (real shape)';  e = 'powershell.exe'; a = '-NoProfile -ExecutionPolicy Bypass -File C:\harvests\harvests-engine\scripts\vps-bot-autosync.ps1'; want = 'fix' },
    @{ n = 'b2-archive (real shape)'; e = 'powershell.exe'; a = '-NoProfile -ExecutionPolicy Bypass -File C:\harvests\harvests-engine\archive-vision-samples.ps1'; want = 'fix' },
    @{ n = 'full path to powershell'; e = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'; a = '-File "C:\x\y.ps1"'; want = 'fix' },
    @{ n = 'pwsh 7';                 e = 'pwsh.exe';       a = '-NoProfile -File C:\x\y.ps1'; want = 'fix' },
    @{ n = 'already hidden';         e = 'powershell.exe'; a = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\x\y.ps1'; want = 'skip' },
    @{ n = 'cmd + quoted .bat';      e = 'cmd.exe';        a = ('/c "' + $batSample + '"'); want = 'manual' },
    @{ n = 'node job';               e = 'node.exe';       a = 'C:\x\bot.cjs'; want = 'manual' },
    @{ n = 'GUI app';                e = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe'; a = '--headless'; want = 'ignore' }
  )

  $bad = 0
  Write-Host '=== SELF TEST (classifier only, no scheduler access) ==='
  Write-Host ('{0,-24} {1,-9} {2,-9} {3}' -f 'case', 'got', 'want', 'rewrite')
  foreach ($f in $fixtures) {
    $got = Resolve-Action -Exe $f.e -Arg $f.a -AllowCmd $false
    $ok = 'ok'
    if ($got.kind -ne $f.want) { $ok = 'BAD'; $bad++ }
    $preview = ''
    if ($got.kind -eq 'fix') { $preview = $got.newExe + ' ' + $got.newArgs }
    Write-Host ('{0,-24} {1,-9} {2,-9} {3}' -f $f.n, $got.kind, $f.want, $preview)
    if ($ok -eq 'BAD') { Write-Host ('   ^^ MISMATCH') }
  }

  # -FixCmd only rewrites when the payload resolves to one existing file.
  $real = Join-Path $PSScriptRoot 'chrome-keeper.ps1'
  $c1 = Resolve-Action -Exe 'cmd.exe' -Arg ('/c "' + $real + '"') -AllowCmd $true
  $c2 = Resolve-Action -Exe 'cmd.exe' -Arg '/c "C:\definitely\not\here.cmd"' -AllowCmd $true
  Write-Host ''
  Write-Host ('=== -FixCmd BEHAVIOUR ===')
  Write-Host ('  existing payload  -> ' + $c1.kind + '  ' + $c1.newExe + ' ' + $c1.newArgs)
  Write-Host ('  missing payload   -> ' + $c2.kind + '  (correctly left as manual)')

  Write-Host ''
  if ($bad -eq 0) {
    Write-Host 'RESULT: classifier OK (0 mismatches).'
    exit 0
  }
  Write-Host ('RESULT: ' + $bad + ' MISMATCH(ES) - do not run this against the scheduler.')
  exit 2
}

$isAdmin = $false
try {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}

if (-not $isAdmin) {
  Write-Host 'WARN: not elevated. Set-ScheduledTask on a "run with highest privileges" task will fail.'
}

# --- scan -----------------------------------------------------------------
$plan    = @()
$manual  = @()
$already = @()
$total   = 0

foreach ($t in (Get-ScheduledTask)) {
  if ($t.State -eq 'Disabled') { continue }
  if ($t.TaskPath -like '\Microsoft\*') { continue }
  if ($t.TaskName -notlike $NameLike) { continue }

  $a = @($t.Actions)[0]
  if ($null -eq $a) { continue }

  $total++
  $exe = [string]$a.Execute
  $arg = [string]$a.Arguments
  $tid = $t.TaskPath + $t.TaskName

  $r = Resolve-Action -Exe $exe -Arg $arg -AllowCmd ([bool]$FixCmd)

  if ($r.kind -eq 'skip')    { $already += $tid; continue }
  if ($r.kind -eq 'ignore')  { continue }
  if ($r.kind -eq 'manual')  {
    $manual += [pscustomobject]@{ Id = $tid; State = [string]$t.State; Command = "$exe $arg" }
    continue
  }

  $plan += [pscustomobject]@{
    Id       = $tid
    State    = [string]$t.State
    TaskName = $t.TaskName
    TaskPath = $t.TaskPath
    WorkDir  = [string]$a.WorkingDirectory
    OldCmd   = "$exe $arg"
    NewExe   = $r.newExe
    NewArgs  = $r.newArgs
  }
}

Write-Host ''
Write-Host ('Scanned ' + $total + ' enabled task(s) outside \Microsoft\.')
Write-Host ''
Write-Host ('=== ALREADY HIDDEN (' + $already.Count + ') ===')
foreach ($s in $already) { Write-Host ('  ok   ' + $s) }

Write-Host ''
if ($plan.Count -eq 0) {
  Write-Host '=== TO FIX (0) === nothing to do.'
} else {
  Write-Host ('=== TO FIX (' + $plan.Count + ') ===')
  foreach ($p in $plan) {
    Write-Host ('  ' + $p.Id + '   [' + $p.State + ']')
    Write-Host ('    was: ' + $p.OldCmd)
    Write-Host ('    now: ' + $p.NewExe + ' ' + $p.NewArgs)
  }
}

Write-Host ''
if ($manual.Count -eq 0) {
  Write-Host '=== MANUAL (0) ==='
} else {
  Write-Host ('=== MANUAL (' + $manual.Count + ') === not PowerShell - decide by hand (or rerun with -FixCmd)')
  foreach ($m in $manual) { Write-Host ('  ' + $m.Id + '  [' + $m.State + ']  ' + $m.Command) }
}

if ($DryRun) {
  Write-Host ''
  Write-Host '[DRYRUN] nothing changed.'
  exit 0
}

if ($plan.Count -eq 0) { exit 0 }

Write-Host ''
Write-Host '=== APPLYING ==='
$ok = 0
$fail = 0
foreach ($p in $plan) {
  try {
    if ([string]::IsNullOrEmpty($p.WorkDir)) {
      $action = New-ScheduledTaskAction -Execute $p.NewExe -Argument $p.NewArgs
    } else {
      $action = New-ScheduledTaskAction -Execute $p.NewExe -Argument $p.NewArgs -WorkingDirectory $p.WorkDir
    }
    Set-ScheduledTask -TaskName $p.TaskName -TaskPath $p.TaskPath -Action $action | Out-Null
    Write-Host ('  OK   ' + $p.Id)
    $ok++
  } catch {
    Write-Host ('  FAIL ' + $p.Id + ' -> ' + $_.Exception.Message)
    $fail++
  }
}

Write-Host ''
Write-Host ('=== RESULT === fixed=' + $ok + '  failed=' + $fail)

Write-Host ''
Write-Host '=== VERIFY (re-read from Task Scheduler) ==='
foreach ($t in (Get-ScheduledTask)) {
  if ($t.TaskPath -like '\Microsoft\*') { continue }
  if ($t.TaskName -notlike $NameLike) { continue }
  $a = @($t.Actions)[0]
  if ($null -eq $a) { continue }
  $mark = 'MISSING'
  if ([string]$a.Arguments -match $hideRe) { $mark = 'hidden' }
  $line = '  ' + $mark.PadRight(8) + ' [' + [string]$t.State + ']  ' + $t.TaskPath + $t.TaskName
  $line = $line + '  ::  ' + [string]$a.Execute + ' ' + [string]$a.Arguments
  Write-Host $line
}

Write-Host ''
Write-Host 'Any row still marked MISSING is a cmd/node/python action - see the MANUAL list above.'
