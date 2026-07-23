@echo off
setlocal
title Portal SAG Web - Production Rollback to Cosmos
cd /d "%~dp0"
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Rollback-PortalSAGWeb-ProductionToCosmos.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Production rollback ended with error code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
