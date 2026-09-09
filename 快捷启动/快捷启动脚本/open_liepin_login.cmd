@echo off
chcp 65001 >nul
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%open_liepin_login.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo 猎聘登录脚本执行失败，错误码：%EXIT_CODE%
  pause
)
exit /b %EXIT_CODE%
