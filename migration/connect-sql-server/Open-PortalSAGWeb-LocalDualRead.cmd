@echo off
setlocal
title Portal SAG Web - Local dual-read connection
cd /d "%~dp0"
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Start-PortalSAGWeb-LocalDualRead.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo The local connection ended with error code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
