@echo off
setlocal
title Portal SAG Web - Guide Builder SQL runtime secret
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Set-PortalSAGWeb-GuideSqlRuntimeSecret.ps1"
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo The Guide Builder SQL secret setup ended with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
