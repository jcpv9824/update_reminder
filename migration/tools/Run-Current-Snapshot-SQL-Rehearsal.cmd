@echo off
setlocal
title Portal SAG Web - CURRENT SNAPSHOT SQL REHEARSAL
cd /d "%~dp0"

echo This validates and loads the current reviewed Cosmos snapshot through one secure migration session.
echo It refuses SAGWebDev and refuses any target that still contains prior operational or migration-run data.
echo Cosmos remains the live response and write source; this does not switch production to SQL.
echo.

pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Invoke-PortalSAGWeb-CurrentSnapshotRehearsal.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo The current-snapshot SQL rehearsal ended with error code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
