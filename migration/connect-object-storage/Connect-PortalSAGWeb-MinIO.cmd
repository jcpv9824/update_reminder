@echo off
setlocal
title Portal SAG Web - secure MinIO connection
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Start-PortalSAGWeb-MinIO-Session.ps1"
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo The MinIO connection check ended with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
