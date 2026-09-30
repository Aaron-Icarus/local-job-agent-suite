@echo off
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%register_bundled_node_path.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo User PATH registration finished. Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
