@echo off
setlocal
title Portal SAG Web - APPLY MIGRATION 015
cd /d "%~dp0"
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Apply-PortalSAGWeb-Migration015.ps1" -Approved
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo Migration 015 ended with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
