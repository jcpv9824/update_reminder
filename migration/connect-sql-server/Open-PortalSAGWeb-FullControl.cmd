@echo off
setlocal
title Portal SAG Web - EPHEMERAL FULL-CONTROL MIGRATION SESSION
cd /d "%~dp0"

echo Enter the owner-approved production migration login.
echo SAGWebDev is accepted only when SQL proves db_owner plus database CONTROL.
echo Existing database permissions are preserved; this controller never downgrades them.
echo The password remains only in this terminal process and is never stored or printed.
echo.

pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Start-PortalSAGWeb-EphemeralControl.ps1" -RequireFullControl -AllowElevatedRuntimeLogin %*
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo The full-control migration session ended with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
