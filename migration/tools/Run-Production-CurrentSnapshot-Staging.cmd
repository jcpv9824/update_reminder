@echo off
setlocal
title Portal SAG Web - PRODUCTION CURRENT SNAPSHOT STAGING
cd /d "%~dp0"

echo This stages the reviewed current Cosmos snapshot in production SQL.
echo It does not replace operational rows and does not switch the application to SQL.
echo Existing database roles and grants are preserved.
echo.

pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Stage-CurrentSnapshot-Production.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Production current-snapshot staging ended with error code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
