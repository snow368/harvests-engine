<#
.SYNOPSIS
  IG Bot 看门狗（VPS 适配版）— 真正检测 Chrome 假死并自动恢复
.DESCRIPTION
  旧版看门狗（根目录遗留）指向错误路径、用 npm 而非 pm2、且只探 /json/version，
  测不出"端口通但协议冻结"的假死 —— 这正是 bot 反复卡死却无人救的根因。
  本版：
    1) 端口层探测（/json/version）
    2) 协议层探针（cdp-probe.cjs：连浏览器级 WS 发命令，5s 无响应 = 假死）
  命中假死 -> kill Chrome + 起重启一次 + pm2 delete/start/save bot-worker（自动重连新 Chrome）
  日志落 C:\harvests\logs\ig-watchdog.log
#>

$ErrorActionPreference = 'SilentlyContinue'

$ChromePath  = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$ProfileDir  = "C:\harvests\profiles\bot_ig_01"
$EngineDir   = "C:\harvests\harvests-engine"
$CdpPort     = 9222
$ProbeScript = Join-Path $PSScriptRoot "cdp-probe.cjs"
$LogDir      = "C:\harvests\logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogPath     = Join-Path $LogDir "ig-watchdog.log"

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Write-Host $line
    Add-Content -Path $LogPath -Value $line
}

function Start-Chrome {
    Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep 2
    Start-Process $ChromePath -ArgumentList "--remote-debugging-port=$CdpPort","--user-data-dir=$ProfileDir","--new-window","https://www.instagram.com"
    Log "Chrome launched (CDP $CdpPort, profile $ProfileDir)"
}

function Restart-Bot {
    Push-Location $EngineDir
    & pm2 delete bot-worker 2>$null
    & pm2 start ecosystem.config.cjs --only bot-worker 2>$null
    & pm2 save 2>$null
    Pop-Location
    Log "bot-worker restarted via pm2 (delete+start+save)"
}

while ($true) {
    # 1) 端口层
    $portUp = $false
    try { $null = Invoke-RestMethod "http://localhost:$CdpPort/json/version" -TimeoutSec 3; $portUp = $true } catch {}

    if (-not $portUp) {
        Log "[ALERT] CDP port down -> restart Chrome"
        Start-Chrome
        Start-Sleep 8
        continue
    }

    # 2) 协议层探针（真·假死检测）
    $probeExit = 0
    if (Test-Path $ProbeScript) {
        & node $ProbeScript 2>$null
        $probeExit = $LASTEXITCODE
    }

    if ($probeExit -eq 1) {
        Log "[ALERT] CDP protocol FROZEN (fake-dead) -> kill Chrome + restart bot"
        Start-Chrome
        Restart-Bot
        Start-Sleep 8
    } elseif ($probeExit -eq 2) {
        Log "[WARN] probe unsupported (no global WebSocket in this node) -> skip protocol check"
    } else {
        Log "[OK] Chrome CDP healthy"
    }

    Start-Sleep -Seconds 60
}
