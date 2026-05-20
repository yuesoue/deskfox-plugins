@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found.
  echo Please install Node.js LTS 18+ from https://nodejs.org then reopen this window.
  echo.
  pause
  exit /b 1
)

node install.mjs %*
set _rc=%errorlevel%

echo.
echo ==============================================================
if %_rc%==0 (
  echo Done. Please fully quit and reopen OpenCode desktop app.
) else (
  echo Failed with code %_rc%. Please send the log above to support.
)
echo ==============================================================
echo.
pause
exit /b %_rc%
