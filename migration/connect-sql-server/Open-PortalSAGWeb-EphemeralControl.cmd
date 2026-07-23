@echo off
setlocal
title Portal SAG Web - EPHEMERAL SQL SESSION
cd /d "%~dp0"
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Start-PortalSAGWeb-EphemeralControl.ps1" -Username "SAGWebDev" %*
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo The ephemeral SQL session ended with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
