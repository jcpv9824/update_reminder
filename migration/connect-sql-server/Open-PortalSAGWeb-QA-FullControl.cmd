@echo off
setlocal
title Portal SAG Web QA - EPHEMERAL FULL-CONTROL SESSION
cd /d "%~dp0"
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Start-PortalSAGWeb-EphemeralControl.ps1" -Environment qa -RequireFullControl -ServerName "data14.sagerp.co,54103" -DatabaseName "PortalSAGWeb-TEST" -SessionDirectory "%~dp0..\work\sql-session-qa" %*
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo The QA full-control session ended with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
