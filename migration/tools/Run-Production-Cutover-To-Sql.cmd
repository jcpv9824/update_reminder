@echo off
setlocal
title Portal SAG Web - production SQL cutover
cd /d "%~dp0"
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Cutover-PortalSAGWeb-ProductionToSql.ps1" %*
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo The production SQL cutover ended with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
