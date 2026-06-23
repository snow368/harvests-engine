@echo off
chcp 65001 >nul
title InkFlow Bot Workers — PM2

:: ── 路径自适应（基于本文件位置） ──
set "ENGINE_DIR=%~dp0"
set "ENGINE_DIR=%ENGINE_DIR:~0,-1%"
for %%i in ("%ENGINE_DIR%") do set "HARVESTS_DIR=%%~dpi"
set "HARVESTS_DIR=%HARVESTS_DIR:~0,-1%"
set "LOGS_DIR=%HARVESTS_DIR%\logs"
set "PROFILE_DIR=%HARVESTS_DIR%\profiles\bot_ig_01"

echo ========================================
echo  InkFlow Bot Workers — 开机自动启动
echo  引擎: %ENGINE_DIR%
echo  日志: %LOGS_DIR%
echo  %date% %time%
echo ========================================
echo.

:: ── 0. 确保日志目录存在 ──
if not exist "%LOGS_DIR%" mkdir "%LOGS_DIR%"

:: ── 1. 杀掉残留 Chrome（防止端口冲突） ──
echo [1/4] 清理残留 Chrome 进程...
taskkill /f /im chrome.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: ── 2. 启动 Chrome（CDP 模式） ──
echo [2/4] 启动 Chrome (CDP port 9222)...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%PROFILE_DIR%" ^
  --no-first-run ^
  --disable-sync ^
  --disable-background-networking ^
  --disable-default-apps
echo      等待 Chrome 就绪...
timeout /t 8 /nobreak >nul

:: ── 3. 启动 PM2 进程 ──
echo [3/4] 启动 PM2 托管进程...
cd /d "%ENGINE_DIR%"

:: 尝试恢复上次保存的快照；如果失败则从 ecosystem 启动
pm2 resurrect 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo      无 PM2 快照，从 ecosystem 启动...
    pm2 start ecosystem.config.js
    pm2 save
) else (
    echo      PM2 已恢复快照
)

:: ── 4. 状态确认 ──
echo [4/4] 检查运行状态...
echo.
pm2 status
echo.
echo ========================================
echo  所有服务已启动
echo  Chrome  : CDP port 9222
echo  PM2 面板: pm2 status
echo  日志    : %LOGS_DIR%
echo ========================================

:: 保持窗口打开 5 秒，方便看日志
timeout /t 5 /nobreak >nul
