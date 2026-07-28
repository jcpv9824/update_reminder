@echo off
setlocal
title Portal SAG Web - secure SeaweedFS S3 connection
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Start-PortalSAGWeb-SeaweedFS-Session.ps1"
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo The SeaweedFS S3 connection check ended with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
