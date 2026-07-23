@echo off
setlocal
title Portal SAG Web - NON-PRODUCTION scheduling/workflow load
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Load-PortalSAGWeb-OperationalSchedulingWorkflow.ps1" %*
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo The non-production scheduling/workflow load ended with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
