@echo off
setlocal
title Portal SAG Web - EPHEMERAL FULL-CONTROL MIGRATION SESSION
cd /d "%~dp0"

echo Use the separate provider migration login. SAGWebDev is runtime-only and will be rejected.
echo The password remains only in this terminal process and is never stored or printed.
echo.

pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Start-PortalSAGWeb-EphemeralControl.ps1" -RequireFullControl %*
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo The full-control migration session ended with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
