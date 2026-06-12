# IG Bot 看门狗 — 每分钟检查一次，挂了自动重启

$ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$ProfileDir = "D:\Crawler_Chrome_Profile"
$ProjectDir = "F:\inkflow app\InkFlow_Project\inkflow_harvests"
$CdpPort = 9222

while ($true) {
    $now = Get-Date -Format "HH:mm:ss"

    # 1. 检查 Chrome CDP
    try {
        $null = Invoke-RestMethod "http://localhost:$CdpPort/json/version" -TimeoutSec 3
        # CDP 正常
    } catch {
        Write-Host "[$now] Chrome CDP down, restarting..."
        # 杀残留 Chrome
        Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep 2
        # 启动新 Chrome
        Start-Process $ChromePath -ArgumentList "--remote-debugging-port=$CdpPort", "--user-data-dir=$ProfileDir", "--new-window", "https://www.instagram.com"
        Write-Host "[$now] Chrome restarted"
        Start-Sleep 8
    }

    # 2. 检查 bot-worker 进程
    $botRunning = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "bot-worker-real" }
    if (-not $botRunning) {
        Write-Host "[$now] Bot worker down, restarting..."
        $env:BOT_ID = "bot_ig_01"
        $env:BOT_CDP_URL = "http://localhost:$CdpPort"
        $env:BOT_EXEC_MODE = "browse_like"
        $env:BOT_LAUNCH_MODE = "cdp"
        $env:HEADLESS = "false"
        Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$ProjectDir'; `$env:BOT_ID='bot_ig_01'; `$env:BOT_CDP_URL='http://localhost:$CdpPort'; `$env:BOT_EXEC_MODE='browse_like'; `$env:BOT_LAUNCH_MODE='cdp'; `$env:HEADLESS='false'; npm run bot:worker:real"
        Write-Host "[$now] Bot restarted"
    }

    Start-Sleep -Seconds 60
}
