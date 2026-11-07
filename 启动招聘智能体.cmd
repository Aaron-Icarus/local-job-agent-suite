@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-recruitment-agent.ps1"
if errorlevel 1 (
  echo.
  echo Startup failed. See messages above.
  pause
)
