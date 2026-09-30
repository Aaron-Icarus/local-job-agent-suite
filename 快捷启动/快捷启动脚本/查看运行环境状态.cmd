@echo off
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%check_runtime.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Runtime status check finished. Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
