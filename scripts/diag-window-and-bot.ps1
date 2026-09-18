# ============================================================
# VPS 自检：① 弹窗真凶（只认可见窗口）② pm2 之外的窗口源
#            ③ bot-worker 零产出卡在哪
#
# 用法（VPS 的 PowerShell 窗口里直接整段粘贴，或另存为 .ps1 后执行）：
#     powershell -NoProfile -ExecutionPolicy Bypass -File diag-window-and-bot.ps1
#
# 2026-09-17 说明：
#   ❌ 不要再数 `Get-Process conhost,cmd` —— windowsHide(CREATE_NO_WINDOW)
#      仍然会创建一个 conhost.exe，只是窗口不可见 ⇒ 计数涨落对"有没有弹窗"
#      毫无判别力。本脚本用 MainWindowHandle -ne 0 判定"可见窗口"。
# ============================================================

$Engine = 'C:\harvests\harvests-engine'
$Logs   = 'C:\harvests\logs'

function Say($s) { Write-Output $s }

# ── ① 可见控制台窗口捕获（默认盯 3 分钟；改 $WatchMin 调时长）──
$WatchMin = 3

Say '=================================================================='
Say "① 可见控制台窗口捕获（盯 $WatchMin 分钟；ctrl+c 可提前结束）"
Say '=================================================================='
$seen = @{}
$already = @(Get-Process conhost -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
if ($already.Count -eq 0) {
  Say '当前：没有可见的 conhost 窗口（干净）'
} else {
  foreach ($p in $already) {
    $seen[$p.Id] = $true
    Say "当前已有：conhost pid=$($p.Id)  title='$($p.MainWindowTitle)'"
  }
}

$deadline = (Get-Date).AddMinutes($WatchMin)
$hit = 0
while ((Get-Date) -lt $deadline) {
  foreach ($p in (Get-Process conhost -ErrorAction SilentlyContinue)) {
    if ($seen.ContainsKey($p.Id)) { continue }
    $seen[$p.Id] = $true
    if ($p.MainWindowHandle -eq 0) { continue }   # 隐藏的控制台，不是弹窗
    $hit++
    Say ''
    Say ">>> $(Get-Date -Format 'HH:mm:ss')  可见窗口！ conhost pid=$($p.Id)  title='$($p.MainWindowTitle)'"
    $par = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
    if ($par) {
      Say "      父进程  : $($par.Name)  pid=$($par.ProcessId)"
      Say "      命令行  : $($par.CommandLine)"
      $gp = Get-CimInstance Win32_Process -Filter "ProcessId=$($par.ParentProcessId)" -ErrorAction SilentlyContinue
      if ($gp) {
        Say "      祖父    : $($gp.Name)  pid=$($gp.ProcessId)"
        Say "      命令行  : $($gp.CommandLine)"
      }
    } else {
      Say '      父进程  : 已退出（只抓到瞬时）'
    }
  }
  Start-Sleep -Milliseconds 300
}
if ($hit -eq 0) { Say "盯了 $WatchMin 分钟：0 个可见窗口 ⇒ pm2 内的弹窗源已清净" }
else            { Say "盯了 $WatchMin 分钟：抓到 $hit 次可见窗口（父/祖父进程见上，pm2 里的名字就是凶手）" }

# ── ② 现存的 console 进程 + 谁拉起来的（找 stray watcher / 手动脚本）──
Say ''
Say '=================================================================='
Say '② 现存 cmd / conhost / python / node 进程（看 ParentProcessId + CreationDate）'
Say '=================================================================='
Get-CimInstance Win32_Process -Filter "Name='cmd.exe' OR Name='conhost.exe' OR Name='python.exe' OR Name='node.exe'" |
  Select-Object ProcessId, ParentProcessId, Name, CreationDate, @{n = 'cmdline'; e = { $_.CommandLine } } |
  Sort-Object Name, ProcessId | Format-Table -AutoSize -Wrap

# ── ③ 计划任务里有没有定时拉起 .bat/.cmd/.ps1/node/python ──
Say ''
Say '=================================================================='
Say '③ 非 Disabled 的计划任务中，会拉起脚本/node/python 的条目'
Say '=================================================================='
$found = $false
foreach ($t in (Get-ScheduledTask | Where-Object { $_.State -ne 'Disabled' })) {
  foreach ($a in $t.Actions) {
    if ("$($a.Execute)" -match '(?i)\.(bat|cmd|ps1|vbs)$|node|python|pm2') {
      $found = $true
      Say ("{0}{1}  [{2}]  {3} {4}" -f $t.TaskPath, $t.TaskName, $t.State, $a.Execute, $a.Arguments)
    }
  }
}
if (-not $found) { Say '（无）—— 没人在 pm2 之外定时拉起脚本' }

# ── ④ bot-worker 为什么零产出 ──
Say ''
Say '=================================================================='
Say '④ bot-worker 卡在哪'
Say '=================================================================='
Say "--- $Logs\bot-worker-out.log（最后 40 行，真日志在这里，不在 .pm2\logs）---"
$of = Join-Path $Logs 'bot-worker-out.log'
if (Test-Path $of) {
  Get-Item $of | Select-Object FullName, Length, LastWriteTime | Format-List
  Get-Content $of -Tail 40
} else { Say "!! 文件不存在：$of" }

Say "--- $Logs\bot-worker-error.log（最后 20 行）---"
$ef = Join-Path $Logs 'bot-worker-error.log'
if (Test-Path $ef) { Get-Content $ef -Tail 20 } else { Say "（不存在：$ef）" }

Say '--- 闸门 ①：控制暂停文件（存在 = 被前台 pause 了，删掉即放行）---'
$pf = Join-Path $Engine 'data\control-pause\bot-worker.pause'
if (Test-Path $pf) { Say "存在 → $pf" } else { Say '不存在 ✅' }

Say '--- 闸门 ②：CDP Chrome 是否还活着（死了 bot 永远连不上）---'
try {
  (Invoke-WebRequest 'http://localhost:9222/json/version' -UseBasicParsing -TimeoutSec 5).Content
} catch {
  Say "!! 9222 连不上：$($_.Exception.Message)"
  Say '   ⇒ CDP Chrome 已死。bot-worker 在 CDP 模式下无法自起浏览器，必须先把那个 Chrome 起回来。'
}

Say '--- 闸门 ③：like_state.rest（D1 侧已证明从未触发过 account_rest）---'
$ls = Join-Path $Engine 'data\bot_state\bot_ig_01_like_state.json'
if (Test-Path $ls) {
  try {
    $j = Get-Content $ls -Raw | ConvertFrom-Json
    if ($j.rest) { $j.rest | ConvertTo-Json -Compress } else { Say 'rest 字段为空 ✅' }
  } catch { Say "解析失败：$($_.Exception.Message)" }
  Get-Item $ls | Select-Object Length, LastWriteTime | Format-List
} else { Say "（不存在：$ls）" }

Say ''
Say '--- pm2 里 bot-worker 的现状（↺ / uptime）---'
pm2 jlist | ConvertFrom-Json |
  Where-Object { $_.name -eq 'bot-worker' } |
  Select-Object name, @{n = 'status'; e = { $_.pm2_env.status } },
                @{n = 'restarts'; e = { $_.pm2_env.restart_time } },
                @{n = 'uptime';   e = { $_.pm2_env.pm_uptime } },
                @{n = 'startedAt'; e = { (Get-Date '1970-01-01').AddMilliseconds($_.pm2_env.pm_uptime).ToLocalTime() } } |
  Format-List

Say ''
Say '=================================================================='
Say '判读：'
Say '  日志尾是 "NOT logged in / challenge"  → 去 Chrome 窗口手动登录（闸门②）'
Say '  日志尾是 "connected via CDP" 之后没了 → 卡在 Playwright await（闸门④）'
Say '                                        → pm2 start ecosystem.config.cjs --only "bot-worker" --update-env'
Say '  日志文件 LastWriteTime 很旧          → 进程根本没在写 = CDP Chrome 没了，先把 Chrome 起回来'
Say '  日志尾是 "control pause active"      → 删 data\control-pause\bot-worker.pause（闸门①）'
Say '=================================================================='
