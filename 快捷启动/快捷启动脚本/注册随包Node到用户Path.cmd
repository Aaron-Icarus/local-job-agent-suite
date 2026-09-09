@echo off
chcp 65001 >nul
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%register_bundled_node_path.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo 用户 PATH 注册结束，错误码：%EXIT_CODE%
pause
exit /b %EXIT_CODE%
