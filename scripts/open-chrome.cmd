@echo off
REM 一键打开指定 IG 账号的浏览器（手动登录/查看用，跟以前手动开 Chrome 一样）
REM 用法:  open-chrome.cmd            -> 默认开 bot_ig_01 (IG_01 主号)
REM        open-chrome.cmd bot_ig_02  -> 开指定号
REM 注意: 仅当对应 bot-worker 未运行时用；用完关掉浏览器窗口，再启动 bot 接管
setlocal
set BOT=%1
if not defined BOT set BOT=bot_ig_01
set PROFILE=C:\harvests\profiles\%BOT%

REM 动态定位 Playwright 自带 Chromium（版本号无关，不怕升级）
set CHROME=
for /d %%p in ("%LOCALAPPDATA%\ms-playwright\chromium-*") do (
  if exist "%%p\chrome-win64\chrome.exe" set CHROME=%%p\chrome-win64\chrome.exe
)
REM 退回系统真 Chrome
if not defined CHROME (
  if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe
  )
)
if not defined CHROME (
  echo [open-chrome] 找不到 chrome.exe，请先安装 Chrome 或 Playwright
  exit /b 1
)
echo [open-chrome] 启动 %BOT% 浏览器: %CHROME%
start "" "%CHROME%" --user-data-dir=%PROFILE%
endlocal
