@echo off
chcp 65001 >nul
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start_dashboard.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo 控制台启动结束或失败，错误码：%EXIT_CODE%
  for %%I in ("%SCRIPT_DIR%..\..") do set "PACKAGE_ROOT=%%~fI"
  echo 如果提示未找到 Node.js，请复制运行：
  echo powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '%PACKAGE_ROOT%'; ^& '.\快捷启动\快捷启动脚本\prepare_runtime_menu.ps1'"
  pause
)
exit /b %EXIT_CODE%
