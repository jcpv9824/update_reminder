@echo off
setlocal
title Portal SAG Web - apply migration 016
cd /d "%~dp0"
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Apply-PortalSAGWeb-Migration016.ps1" %*
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo Migration 016 ended with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
