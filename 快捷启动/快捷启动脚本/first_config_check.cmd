@echo off
chcp 65001 >nul
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%first_config_check.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo 配置检查结束，错误码：%EXIT_CODE%
pause
exit /b %EXIT_CODE%
