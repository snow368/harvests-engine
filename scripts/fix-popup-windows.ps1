<#
  fix-popup-windows.ps1 - stop Task Scheduler from flashing console windows on the VPS.

  WHY THIS EXISTS (2026-09-18, user report: a CMD window keeps popping up):
    A scheduled task whose action is a console program gets a brand-new *visible*
    console window every single time it fires, in the interactive session.
    `harvests-bot-autosync` runs every 5 minutes = 288 flashes per day. That is
    the entire popup story.

    It is NOT pm2: ForkMode.js launches apps with windowsHide: true.
    It is NOT the bot's own child processes: scripts/check-windows-hide.mjs
    audits every spawn/exec in the pm2-managed scripts and they all pass
    ("9 managed scripts, 5 call points, all carry windowsHide").

  TWO ROUNDS, TWO DIFFERENT FIXES - do not confuse them:

    ROUND 1 (default mode): prepend -WindowStyle Hidden.
      Removes the window for most people. Correct, cheap, behaviour-preserving
      (PowerShell accepts named parameters in any order).

    ROUND 2 (-UseWrapper): replace the whole command with wscript.exe + run-hidden.vbs.
      Needed because -WindowStyle Hidden does NOT stop the console from being
      CREATED - the OS creates the console host before PowerShell code runs and
      PowerShell only hides it afterwards, which is visible as a flash. This was
      confirmed on the VPS on 2026-09-18: after round 1 was applied to every
      task, the flash was still there. wscript.exe is a GUI-subsystem binary, so
      no console is ever created; WshShell.Run(..., 0, True) starts the child
      with SW_HIDE from the first frame, and still propagates the exit code.
      USE THIS MODE IF THE FLASH SURVIVED ROUND 1.

  WHAT IT DOES:
    * Enumerates every ENABLED scheduled task outside \Microsoft\ (built-ins are
      left alone). Nothing is ever deleted, nothing is ever created.
    * powershell.exe / pwsh.exe action -> rewritten in place.
      Applied via Set-ScheduledTask (never schtasks /TR), so quoting cannot be
      mangled; trigger / principal / settings are preserved untouched.
    * cmd / node / python actions -> reported as MANUAL and never guessed at,
      because rewriting the payload into another interpreter is a behaviour
      change. Opt in with -FixCmd to also rewrite the two shapes that are safe
      to rewrite because the payload is a single, existing file:
        cmd /c "<file>"        ->  hidden launcher for <file>
        <file>.cmd <args>      ->  hidden launcher for <file> <args>
      (the VPS has the second shape: PM2Resume runs %APPDATA%\npm\pm2.cmd
      resurrect). PowerShell's call operator still runs .bat/.cmd through
      cmd.exe, and -WorkingDirectory is carried over.
    * Idempotent in both modes: anything already correct is skipped. Wrapper mode
      also rewrites tasks that already carry -WindowStyle Hidden, on purpose,
      because that is exactly the population that still flashed.
    * Wrapper mode REFUSES any command line containing a double quote, because
      the wrapper has to embed it inside quotes. Those are listed as MANUAL.

  USAGE (VPS, Administrator PowerShell):
    cd C:\harvests\harvests-engine
    # 0) prove the classifier itself (no scheduler access, changes nothing)
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-popup-windows.ps1 -SelfTest
    # 1) see the exact plan, change nothing
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-popup-windows.ps1 -DryRun -UseWrapper
    # 2) apply, then read the built-in VERIFY table
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-popup-windows.ps1 -UseWrapper
    # 3) undo is mechanical: the plan prints the original command line as "was:",
    #    so it can be fed straight back into New-ScheduledTaskAction.

  ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI(936),
  where a UTF-8 Chinese comment can emit a trailing 0x60 (backtick) = line
  continuation, which swallows the next brace and breaks the file with
  "MissingCatchOrFinally". Keeping this file pure ASCII makes that impossible.
  run-hidden.vbs is ASCII-only for the same reason.
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  # Optional filter, e.g. -NameLike 'harvests*'. Default = every user task.
  [string]$NameLike = '*',
  # Also convert `cmd /c "<one existing file>"` into a hidden launcher. Opt-in.
  [switch]$FixCmd,
  # Round 2: route every console action through wscript.exe + run-hidden.vbs.
  [switch]$UseWrapper,
  # Path to the launcher. Defaults to run-hidden.vbs next to this script.
  [string]$WrapperPath = '',
  # Run the classifier against built-in fixtures and exit. Touches nothing.
  [switch]$SelfTest
)

$ErrorActionPreference = 'Continue'

if ([string]::IsNullOrEmpty($WrapperPath)) {
  $WrapperPath = Join-Path $PSScriptRoot 'run-hidden.vbs'
}

# --- classification rules -------------------------------------------------
# Note the `\b` instead of `$` in $otherRe: a task action is usually
#   cmd /c "C:\...\start-bots.bat"
# and the trailing quote made an anchored `\.bat$` test miss it, so a real
# popup source was silently reported as "nothing to do". Match the token.
$hideRe   = '-WindowStyle\s+Hidden'
$psExeRe  = '(?i)(powershell|pwsh)(\.exe)?$'
$cmdExeRe = '(?i)^(.*\\)?cmd(\.exe)?$'
$wsExeRe  = '(?i)wscript(\.exe)?$'
$otherRe  = '(?i)\.(bat|cmd|ps1|vbs)\b|\b(node|python|pythonw|wscript|cscript|conhost)\b|\bpm2\b'

function Resolve-Action {
  param(
    [string]$Exe,
    [string]$Arg,
    [bool]$AllowCmd = $false,
    # Wrapper mode must revisit actions that already say -WindowStyle Hidden:
    # those are precisely the ones that still flashed.
    [bool]$IgnoreHidden = $false
  )

  # kind: skip | fix | manual | ignore
  $r = @{ kind = 'ignore'; newExe = $Exe; newArgs = $Arg }

  if ([string]::IsNullOrEmpty($Exe)) { return $r }

  # Already routed through the launcher.
  if (($Exe -match $wsExeRe) -and ($Arg -match '(?i)run-hidden\.vbs')) {
    $r.kind = 'skip'
    return $r
  }

  if ((-not $IgnoreHidden) -and ($Arg -match $hideRe)) {
    $r.kind = 'skip'
    return $r
  }

  if ($Exe -match $psExeRe) {
    $r.kind = 'fix'
    if ($Arg -match $hideRe) {
      $r.newArgs = $Arg                      # do not stack a second Hidden
    } else {
      $r.newArgs = '-WindowStyle Hidden ' + $Arg
    }
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

  # Sometimes the action *is* a batch file, with no `cmd` in sight - the VPS has
  # exactly this:  Execute = C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd
  #                Arguments = resurrect
  # The scheduler still creates a console for it, so it flashes just the same.
  # Same wrapper. Refuse when the path is missing or the arguments contain a
  # quote, because the wrapper could then be mis-parsed.
  if ($AllowCmd -and ($Exe -match '(?i)\.(cmd|bat)$') -and (Test-Path -LiteralPath $Exe) -and ($Arg -notmatch '"')) {
    $r.kind = 'fix'
    $r.newExe = 'powershell.exe'
    if ([string]::IsNullOrEmpty($Arg)) {
      $r.newArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& ''' + $Exe + '''"'
    } else {
      $r.newArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& ''' + $Exe + ''' ' + $Arg + '"'
    }
    return $r
  }

  $r.kind = 'manual'
  return $r
}

# A bare `powershell` in a task action resolves through the machine PATH, which
# a scheduled task does have. Pin the absolute path anyway: the wrapper string is
# built once and then lives in the scheduler, where a PATH change is invisible.
function Resolve-FullProgram {
  param([string]$Exe)
  if ($Exe -match '(?i)^powershell(\.exe)?$') {
    $p = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $Exe
}

function Get-WscriptPath {
  $p = Join-Path $env:SystemRoot 'System32\wscript.exe'
  if (Test-Path -LiteralPath $p) { return $p }
  return 'wscript.exe'
}

# Wrap an already-resolved command so that no console is ever created.
function Wrap-Action {
  param(
    [string]$Exe,
    [string]$Arg,
    [string]$VbsPath
  )

  $r = @{ kind = 'manual'; newExe = $Exe; newArgs = $Arg }

  $inner = ((Resolve-FullProgram -Exe $Exe) + ' ' + $Arg).Trim()

  # The inner command line is embedded inside a quoted argument, so a double
  # quote in it would be re-parsed by wscript. Refuse rather than guess.
  if ($inner -match '"') { return $r }

  $r.kind = 'fix'
  $r.newExe = Get-WscriptPath
  $r.newArgs = '"' + $VbsPath + '" "' + $inner + '"'
  return $r
}

if ($SelfTest) {
  $batSample = 'C:\harvests\harvests-engine\start-bots.bat'
  $fixtures = @(
    @{ n = 'autosync (real shape)';  e = 'powershell.exe'; a = '-NoProfile -ExecutionPolicy Bypass -File C:\harvests\harvests-engine\scripts\vps-bot-autosync.ps1'; want = 'fix' },
    @{ n = 'autosync (no .exe!)';    e = 'powershell';     a = '-ExecutionPolicy Bypass -File C:\harvests\harvests-engine\scripts\vps-bot-autosync.ps1'; want = 'fix' },
    @{ n = 'b2-archive (real shape)'; e = 'powershell.exe'; a = '-NoProfile -ExecutionPolicy Bypass -File C:\harvests\harvests-engine\archive-vision-samples.ps1'; want = 'fix' },
    @{ n = 'full path to powershell'; e = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'; a = '-File "C:\x\y.ps1"'; want = 'fix' },
    @{ n = 'pwsh 7';                 e = 'pwsh.exe';       a = '-NoProfile -File C:\x\y.ps1'; want = 'fix' },
    @{ n = 'already hidden';         e = 'powershell.exe'; a = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\x\y.ps1'; want = 'skip' },
    @{ n = 'already wrapped';        e = 'wscript.exe';    a = '"C:\h\run-hidden.vbs" "C:\x\p.exe -File C:\x\y.ps1"'; want = 'skip' },
    @{ n = 'cmd + quoted .bat';      e = 'cmd.exe';        a = ('/c "' + $batSample + '"'); want = 'manual' },
    @{ n = 'batch AS the execute';   e = 'C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd'; a = 'resurrect'; want = 'manual' },
    @{ n = 'node job';               e = 'node.exe';       a = 'C:\x\bot.cjs'; want = 'manual' },
    @{ n = 'GUI app';                e = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe'; a = '--headless'; want = 'ignore' },
    @{ n = 'updater task';           e = 'C:\Program Files (x86)\Microsoft\EdgeUpdate\MicrosoftEdgeUpdate.exe'; a = '/c'; want = 'ignore' }
  )

  $bad = 0
  Write-Host '=== SELF TEST 1/2: classifier (no scheduler access) ==='
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

  # The "action IS a batch file" shape. Probe for one that exists on this box so
  # the self test actually asserts the branch instead of silently skipping.
  # On the VPS the first candidate exists (Administrator's npm\pm2.cmd).
  $batchSample = $null
  foreach ($cand in @(
    (Join-Path $env:APPDATA 'npm\pm2.cmd'),
    (Join-Path (Split-Path $PSScriptRoot -Parent) 'start-bots.bat')
  )) {
    if ($cand -and (Test-Path -LiteralPath $cand)) { $batchSample = $cand; break }
  }
  $c3 = $null
  if ($batchSample) { $c3 = Resolve-Action -Exe $batchSample -Arg 'run' -AllowCmd $true }

  Write-Host ''
  Write-Host ('=== -FixCmd BEHAVIOUR ===')
  Write-Host ('  cmd /c <existing file>  -> ' + $c1.kind + '  ' + $c1.newExe + ' ' + $c1.newArgs)
  Write-Host ('  cmd /c <missing file>   -> ' + $c2.kind + '  (correctly left as manual)')
  if ($null -eq $c3) {
    Write-Host '  <batch file> as execute -> skipped (no sample batch found on this machine)'
  } else {
    Write-Host ('  <batch> as execute      -> ' + $c3.kind + '  ' + $c3.newExe + ' ' + $c3.newArgs)
    if ($c3.kind -ne 'fix') { $bad++; Write-Host '   ^^ MISMATCH (expected fix)' }
  }

  # --- round 2: the wrapper -------------------------------------------------
  # The autosync task is the one that runs 288 times a day, so it is the shape
  # that matters. Assert the exact string the scheduler will receive.
  $autosyncArg = '-ExecutionPolicy Bypass -File C:\harvests\harvests-engine\scripts\vps-bot-autosync.ps1'
  $w1 = Wrap-Action -Exe 'powershell'      -Arg $autosyncArg -VbsPath 'C:\h\scripts\run-hidden.vbs'
  $w2 = Wrap-Action -Exe 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Arg '-WindowStyle Hidden -File C:\x\y.ps1' -VbsPath 'C:\h\scripts\run-hidden.vbs'
  $w3 = Wrap-Action -Exe 'powershell.exe'  -Arg '-Command "& ''C:\x\y.cmd'' resurrect"' -VbsPath 'C:\h\scripts\run-hidden.vbs'

  Write-Host ''
  Write-Host '=== SELF TEST 2/2: -UseWrapper (nothing touches the scheduler) ==='
  Write-Host ('  powershell <args>        -> ' + $w1.kind)
  Write-Host ('    ' + $w1.newExe + ' ' + $w1.newArgs)
  if ($w1.kind -ne 'fix')       { $bad++; Write-Host '   ^^ MISMATCH (expected fix)' }
  if ($w1.newArgs -notmatch '(?i)run-hidden\.vbs') { $bad++; Write-Host '   ^^ MISMATCH (launcher not in the command line)' }
  if ($w1.newExe  -notmatch '(?i)wscript')         { $bad++; Write-Host '   ^^ MISMATCH (not wscript)' }

  Write-Host ('  already -WindowStyle Hidden -> ' + $w2.kind + '  (wrapper mode must still rewrite it)')
  if ($w2.kind -ne 'fix') { $bad++; Write-Host '   ^^ MISMATCH (expected fix)' }

  Write-Host ('  command line has a quote  -> ' + $w3.kind + '  (correctly refused: cannot embed safely)')
  if ($w3.kind -ne 'manual') { $bad++; Write-Host '   ^^ MISMATCH (expected manual)' }

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

if ($UseWrapper) {
  if (-not (Test-Path -LiteralPath $WrapperPath)) {
    Write-Host ('ERROR: -UseWrapper needs the launcher, and it is not there: ' + $WrapperPath)
    Write-Host '       Point -WrapperPath at run-hidden.vbs and try again. Nothing was changed.'
    exit 3
  }
  Write-Host ('MODE: wrapper -> ' + $WrapperPath)
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

  $r = Resolve-Action -Exe $exe -Arg $arg -AllowCmd ([bool]$FixCmd) -IgnoreHidden ([bool]$UseWrapper)

  # Round 2 composes on top of round 1: whatever Resolve-Action decided, the
  # resulting command line is what gets wrapped.
  if ($UseWrapper -and ($r.kind -eq 'fix')) {
    $r = Wrap-Action -Exe $r.newExe -Arg $r.newArgs -VbsPath $WrapperPath
  }

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
Write-Host ('=== ALREADY CORRECT (' + $already.Count + ') ===')
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
  if (([string]$a.Execute -match $wsExeRe) -and ([string]$a.Arguments -match 'run-hidden\.vbs')) { $mark = 'wrapped' }
  $line = '  ' + $mark.PadRight(8) + ' [' + [string]$t.State + ']  ' + $t.TaskPath + $t.TaskName
  $line = $line + '  ::  ' + [string]$a.Execute + ' ' + [string]$a.Arguments
  Write-Host $line
}

Write-Host ''
Write-Host 'Now prove it did not break the schedule (the risk here is a lost TRIGGER,'
Write-Host 'not the window): Get-ScheduledTaskInfo must still show a NextRunTime, and'
Write-Host 'LastTaskResult must go back to 0 on the next fire.'
Write-Host 'Any row still marked MISSING is a cmd/node/python action - see MANUAL above.'
