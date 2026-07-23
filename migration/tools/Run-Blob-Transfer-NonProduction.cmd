@echo off
setlocal
title Portal SAG Web - NON-PRODUCTION private Blob transfer
cd /d "%~dp0"
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Transfer-PortalSAGWeb-Blobs.ps1" %*
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo The non-production private Blob transfer ended with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
