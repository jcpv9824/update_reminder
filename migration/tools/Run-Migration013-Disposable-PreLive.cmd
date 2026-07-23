@echo off
setlocal
title Portal SAG Web - APPLY MIGRATION 013
cd /d "%~dp0"
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Apply-PortalSAGWeb-Migration013.ps1" -Approved
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo Migration 013 ended with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
