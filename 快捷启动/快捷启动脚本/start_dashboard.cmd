@echo off
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start_dashboard.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Console start finished or failed. Exit code: %EXIT_CODE%
  echo If Node.js is missing, run prepare_runtime_menu.ps1 first.
  pause
)
exit /b %EXIT_CODE%
