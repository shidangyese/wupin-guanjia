@echo off
title WuPin GuanJia Server
cd /d "%~dp0"
echo ==============================================
echo  Item Manager local server
echo  On this PC  : http://localhost:8680
echo  On phone    : http://YOUR-PC-IP:8680   (same Wi-Fi)
echo  Your PC IP(s):
ipconfig | findstr IPv4
echo.
echo  Close this window to stop the server.
echo ==============================================
where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
  goto end
)
where py >nul 2>nul
if %errorlevel%==0 (
  py -m http.server 8680
  goto end
)
where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server 8680
  goto end
)
echo [!] Neither Node.js nor Python was found.
echo     Please install one of them, or ask ZCode for help.
:end
pause
