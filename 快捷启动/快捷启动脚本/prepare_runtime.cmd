@echo off
set "SCRIPT_DIR=%~dp0"
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%prepare_runtime_menu.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%prepare_runtime.ps1" %*
)
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Runtime preparation finished. Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
