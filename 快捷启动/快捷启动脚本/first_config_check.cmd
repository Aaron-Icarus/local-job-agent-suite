@echo off
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%first_config_check.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Config check finished. Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
