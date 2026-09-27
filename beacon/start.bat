@echo off
rem starts the beacon from a downloaded copy. double-click on windows.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo node is not installed. get it from https://nodejs.org (the LTS button), then run this again.
  pause
  exit /b 1
)
if not exist node_modules npm install --omit=dev --no-audit --no-fund
node server.mjs %*
pause
