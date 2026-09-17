<#
  repair-bot-runner.ps1 —— 让 VPS 上的 IG bot 真正跑起来（2026-09-17）

  这一把同时解决三件事：
   ① 抓取器不该在 VPS 跑  → 拉新配置（配置级剔除）+ 停 pm2 条目 + 杀逃逸的 python 孤儿
   ② 揪出并停掉【pm2 之外】的 bot 重启源（ig-watchdog.ps1 / watchdog.bat / start-bots.bat / 计划任务）
      —— 这些才是 ↺ 疯涨、每 ~3 分钟重启一次、每分钟弹一个 cmd 窗口的元凶；
         pm2 的 stop/restart 完全拦不住它们（它们自己会 pm2 delete + start）
   ③ 干净重启 9222 的 Chrome + 重建 bot-worker（delete 清脏表项 → start 读新配置）
  最后自动打印 bot-worker 的 out / error 日志尾 + 判读结论。

  用法（VPS，管理员 PowerShell）：
    cd C:\harvests\harvests-engine
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\repair-bot-runner.ps1

  可选参数：
    -SkipPull            不执行 git pull
    -SkipChromeRestart   不重启 Chrome（保留当前浏览器会话）
    -WaitSeconds 90      重建后等多久再抓日志（默认 90 秒）
#>
param(
  [switch]$SkipPull,
  [switch]$SkipChromeRestart,
  [int]$WaitSeconds = 90
)

$ErrorActionPreference = 'Continue'

$EngineDir  = 'C:\harvests\harvests-engine'
$LogDir     = 'C:\harvests\logs'
$ChromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$ProfileDir = 'C:\harvests\profiles\bot_ig_01'
$CdpPort    = 9222

function Say([string]$m) { Write-Host $m }
function Head([string]$m) { Write-Host ''; Write-Host ('=' * 72); Write-Host "== $m"; Write-Host ('=' * 72) }
function Line([string]$m) { Write-Host "  $m" }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Say '!! 不是管理员：禁用计划任务 / pm2 save 可能失败，建议用管理员 PowerShell 重跑。' }

if (-not (Test-Path $EngineDir)) { Say "!! 找不到 $EngineDir，停止。"; exit 1 }
Set-Location $EngineDir

# ─────────────────────────────────────────────────────────────────────
Head '第 0 步 已知真因：现在就把日志摊开（修复前先留证据）'
$errLog = Join-Path $LogDir 'bot-worker-error.log'
if (Test-Path $errLog) {
  Say '--- bot-worker-error.log  尾 25 行（fatal / ensureBrowser 失败原因都在这）---'
  Get-Content $errLog -Tail 25
} else { Say "  (无 $errLog)" }

$wdLog = Join-Path $LogDir 'ig-watchdog.log'
if (Test-Path $wdLog) {
  Say ''
  Say '--- ig-watchdog.log  尾 15 行（若这里每几分钟一行 ALERT，说明看门狗在反复杀 Chrome + 重启 bot）---'
  Get-Content $wdLog -Tail 15
}

$outLog = Join-Path $LogDir 'bot-worker-out.log'
if (Test-Path $outLog) {
  Say ''
  Say '--- bot-worker-out.log  尾 12 行 ---'
  Get-Content $outLog -Tail 12
}

# ─────────────────────────────────────────────────────────────────────
Head '第 1 步 抓取器从 VPS 下架（pm2 条目 + python 孤儿）'
& pm2 stop maps-scrape-scheduler 2>$null | Out-Null
Line 'pm2 stop maps-scrape-scheduler  (配置级剔除见第 2 步)'
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like '*python_scraper.py*' } |
  ForEach-Object { Line "kill 逃逸的 python pid=$($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }
& pm2 save 2>$null | Out-Null
Line 'done'

# ─────────────────────────────────────────────────────────────────────
Head '第 2 步 拉新配置（配置级剔除 + bot 修复代码）'
if ($SkipPull) {
  Line '(-SkipPull：跳过)'
} else {
  # 工作区脏文件会挡住 fast-forward ⇒ pull 静默 no-op。VPS 手工调参已于 90f09ce 回收进仓库，可安全丢弃。
  & git checkout -- ecosystem.config.cjs 2>$null
  $pull = & git pull --ff-only 2>&1
  $pull | ForEach-Object { Line $_ }
}
$head = (& git rev-parse --short HEAD 2>$null)
Line "当前 commit = $head"

if (Test-Path (Join-Path $EngineDir 'ecosystem.config.cjs')) {
  $names = & node -e "console.log(require('./ecosystem.config.cjs').apps.map(a=>a.name).join(', '))" 2>$null
  Say ''
  Line "pm2 配置里的 app = $names"
  if ("$names" -match 'maps-scrape-scheduler') {
    Line '!! 仍然包含 maps-scrape-scheduler ⇒ 仓库这份配置还没更新（或 pull 没生效），第 3 步的重启源排查更关键。'
  } else {
    Line 'OK：默认不再包含 maps-scrape-scheduler（VPS 上 pm2 不会再拉起抓取器）。'
  }
}

# ─────────────────────────────────────────────────────────────────────
Head '第 3 步 揪出【pm2 之外】的 bot 重启源（这才是每 3 分钟重启 + 每分钟弹窗的真凶）'
Say '--- (a) 正在运行的 watchdog / start-bots / cdp-probe 进程 ---'
$bad = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $PID -and
  $_.CommandLine -and
  ($_.CommandLine -match '(?i)ig-watchdog|watchdog\.bat|start-bots\.bat|cdp-probe') -and
  ($_.CommandLine -notmatch '(?i)repair-bot-runner')
})
if ($bad.Count -eq 0) {
  Line '(无)'
} else {
  foreach ($p in $bad) {
    Line ("kill  {0}(pid={1})  {2}" -f $p.Name, $p.ProcessId, $p.CommandLine)
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { Line "  (杀不掉：$($_.Exception.Message))" }
  }
}

Say ''
Say '--- (b) 计划任务里引用 watchdog / bot-worker 的条目（会随开机/定时复活，必须禁用） ---'
$foundTask = 0
$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.State -ne 'Disabled' })
foreach ($t in $tasks) {
  foreach ($a in @($t.Actions)) {
    $line = "$($a.Execute) $($a.Arguments)"
    if ($line -match '(?i)ig-watchdog|watchdog\.bat|start-bots\.bat|cdp-probe|bot-worker') {
      $foundTask++
      Line "[!] $($t.TaskPath)$($t.TaskName)  [$($t.State)]  $line"
      try {
        Disable-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction Stop | Out-Null
        Line "    -> 已禁用。恢复命令：Enable-ScheduledTask -TaskName '$($t.TaskName)' -TaskPath '$($t.TaskPath)'"
      } catch {
        Line "    -> 禁用失败：$($_.Exception.Message)"
      }
    }
  }
}
if ($foundTask -eq 0) { Line '(无)' }

Say ''
Say '--- (c) 启动项（Run 键 / 启动文件夹） ---'
$startup = @(Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue |
  Where-Object { $_.Command -match '(?i)watchdog|scraper|harvests|bot-worker|cdp-probe' })
if ($startup.Count -eq 0) { Line '(无)' } else {
  $startup | ForEach-Object { Line "$($_.Name)  [$($_.Location)]  $($_.Command)" }
}

# ─────────────────────────────────────────────────────────────────────
Head '第 4 步 干净重启 9222 的 Chrome（CDP 假死/协议冻结的唯一根治手段）'
if ($SkipChromeRestart) {
  Line '(-SkipChromeRestart：跳过。若 bot 仍连不上 CDP，请不带走这个参数重跑)'
} else {
  Line '杀掉所有 chrome（VPS 上已无抓取器，不会误伤）...'
  Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 3
  if (Test-Path $ChromePath) {
    Start-Process $ChromePath -ArgumentList "--remote-debugging-port=$CdpPort", "--user-data-dir=$ProfileDir", "--new-window", 'https://www.instagram.com'
    Line "已启动 Chrome：profile=$ProfileDir  CDP=$CdpPort"
  } else {
    Line ('!! 找不到 Chrome 可执行文件：' + $ChromePath + ' —— 请修改脚本顶部的 $ChromePath')
  }
  # 等 CDP 就绪（最多 30s）
  $ok = $false
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 2
    try {
      $v = Invoke-RestMethod "http://localhost:$CdpPort/json/version" -TimeoutSec 3
      Line "CDP 就绪：$($v.Browser)"
      $ok = $true
      break
    } catch {}
  }
  if (-not $ok) { Line '!! 30 秒内 CDP 没起来，请手动确认 Chrome 窗口是否开着' }
  try {
    $tabs = (Invoke-RestMethod "http://localhost:$CdpPort/json/list" -TimeoutSec 3).Count
    Line "当前标签数 = $tabs（IG 会话靠 profile 保留，不需要重登；若被踢到登录页请在窗口里登录一次）"
  } catch {}
}

# ─────────────────────────────────────────────────────────────────────
Head '第 5 步 重建 bot-worker（delete 清脏 pm2 表项 → start 读新配置）'
& pm2 delete bot-worker 2>$null | Out-Null
Line 'pm2 delete bot-worker  (顺便把 ↺ 计数归零，方便判断新代码是否真的跑起来)'
& pm2 start ecosystem.config.cjs --only bot-worker --update-env 2>&1 | ForEach-Object { Line $_ }
& pm2 save 2>$null | Out-Null

# ─────────────────────────────────────────────────────────────────────
Head "第 6 步 等 $WaitSeconds 秒后看结果"
Start-Sleep -Seconds $WaitSeconds

Say '--- pm2 list ---'
& pm2 list 2>&1 | ForEach-Object { Line $_ }

if (Test-Path $outLog) {
  Say ''
  Say '--- bot-worker-out.log 尾 30 行 ---'
  Get-Content $outLog -Tail 30
}
if (Test-Path $errLog) {
  Say ''
  Say '--- bot-worker-error.log 尾 20 行 ---'
  Get-Content $errLog -Tail 20
}

Say ''
Say '--- 判读 ---'
$tail = ''
if (Test-Path $outLog) { $tail = (Get-Content $outLog -Tail 60) -join "`n" }
if ($tail -match 'connected via CDP') {
  Say '  ✅ 已连上 CDP Chrome，正式进入任务轮询（下一步看 bot_behavior_logs 是否出现新的 task_start）'
} elseif ($tail -match 'startup failed') {
  Say '  🟡 启动仍在失败，但原因已写在上面 out 日志里（startup failed: ...）—— 把那一行发我即可定位'
} elseif ($tail -match 'browser ensure attempt .* failed') {
  Say '  🟡 CDP 连接失败（原因见上一行）→ 多半是 Chrome 仍假死，重跑本脚本一次（第 4 步会再重启一次 Chrome）'
} else {
  Say '  🟡 暂未看到 "connected via CDP"，把上面 out / error 日志尾发我'
}
Say '  ✅ 收尾核对：pm2 list 里 bot-worker 的 ↺ 应停在 0/1 且不再每 3 分钟上涨；'
Say '                C:\harvests\logs\bot-worker-out.log 应持续新增（不再只有启动时的 config 打印）。'
