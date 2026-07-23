@echo off
setlocal
title Portal SAG Web - Migration 019
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Apply-PortalSAGWeb-Migration019.ps1" %*
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" echo Migration 019 ended with error code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
