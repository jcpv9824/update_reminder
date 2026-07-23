@echo off
setlocal
title Portal SAG Web - ENTER PRODUCTION MAINTENANCE
cd /d "%~dp0"
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Enter-PortalSAGWeb-ProductionMaintenance.ps1" %*
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" echo Production maintenance entry ended with error code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
