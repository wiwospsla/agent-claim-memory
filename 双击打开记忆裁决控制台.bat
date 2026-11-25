@echo off
setlocal
title Agent Claim Memory Console
cd /d "%~dp0"
echo Starting Agent Claim Memory Console ...
node src\launch.mjs
if errorlevel 1 (
  echo.
  echo Failed to start. Make sure Node.js 20+ is installed and on PATH.
  pause
)
endlocal
