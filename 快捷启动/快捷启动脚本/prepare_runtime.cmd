@echo off
chcp 65001 >nul
set "SCRIPT_DIR=%~dp0"
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%prepare_runtime_menu.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%prepare_runtime.ps1" %*
)
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo 运行环境准备结束，错误码：%EXIT_CODE%
pause
exit /b %EXIT_CODE%
