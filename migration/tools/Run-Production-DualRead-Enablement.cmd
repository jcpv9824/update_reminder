@echo off
setlocal
title Portal SAG Web - Production Dual-Read Enablement
cd /d "%~dp0"
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Enable-PortalSAGWeb-ProductionDualRead.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Production dual-read enablement ended with error code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
