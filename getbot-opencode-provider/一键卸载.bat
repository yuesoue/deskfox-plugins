@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found.
  echo Please install Node.js LTS from https://nodejs.org
  echo.
  pause
  exit /b 1
)

node install.mjs --uninstall
set _rc=%errorlevel%

echo.
echo ==============================================================
echo Done. Please fully quit and reopen OpenCode desktop app.
echo ==============================================================
echo.
pause
exit /b %_rc%
