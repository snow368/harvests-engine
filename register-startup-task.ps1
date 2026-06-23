<#
.SYNOPSIS
    注册 Windows Task Scheduler 任务，开机自启 InkFlow Bot Workers
.DESCRIPTION
    基于 $PSScriptRoot 自动推断路径，任何 Windows VPS 都能用。
.NOTES
    以管理员身份运行：
      cd <harvests-engine 目录>
      Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
      .\register-startup-task.ps1
#>

$engineDir = $PSScriptRoot
$harvestsDir = Split-Path $engineDir -Parent
$batPath = Join-Path $engineDir "start-bots.bat"
$taskName = "InkFlow Bot Workers"

Write-Host "=== InkFlow Bot Workers — 开机自启注册 ==="
Write-Host "引擎目录: $engineDir"
Write-Host "项目目录: $harvestsDir"
Write-Host ""

# ===== 1. 验证 bat 存在 =====
if (-not (Test-Path $batPath)) {
    Write-Error "未找到 start-bots.bat: $batPath"
    Write-Host "请确认 start-bots.bat 与本脚本在同一目录。"
    exit 1
}

# ===== 2. 检查管理员权限 =====
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")
if (-not $isAdmin) {
    Write-Warning "建议以管理员身份运行此脚本。"
    $confirm = Read-Host "继续吗？(y/N)"
    if ($confirm -ne 'y') { exit }
}

# ===== 3. 创建计划任务 =====
Write-Host "正在创建计划任务 '$taskName' ..."

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$batPath`"" -WorkingDirectory $engineDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId (whoami) -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Priority 6

try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
    Write-Host ""
    Write-Host "✅ 注册成功！"
    Write-Host "  触发:   系统启动时"
    Write-Host "  执行:   $batPath"
    Write-Host "  用户:   $(whoami)"
    Write-Host ""
    Write-Host "手动测试:  .\start-bots.bat"
    Write-Host "查看日志:  $harvestsDir\logs\"
    Write-Host "卸载任务:  Task Scheduler 中删除 '$taskName'"

    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Write-Host "当前状态: $($task.State)"
    }
}
catch {
    Write-Error "创建失败: $_"
    Write-Host ""
    Write-Host "手动创建："
    Write-Host "  1. Win+R → taskschd.msc"
    Write-Host "  2. 创建任务 → 名称 = $taskName，勾选最高权限"
    Write-Host "  3. 触发器 → 启动时"
    Write-Host "  4. 操作 → cmd /c `"$batPath`""
    Write-Host "  5. 确定"
}
