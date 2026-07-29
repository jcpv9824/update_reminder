@echo off
setlocal
title Portal SAG Web - apply and verify production migration 027
cd /d "%~dp0"

set "SESSION_DIR=%~dp0..\work\sql-session-deploy-027"
set "CONTROL_SCRIPT=%~dp0..\connect-sql-server\Start-PortalSAGWeb-EphemeralControl.ps1"
set "BACKUP_SCRIPT=%~dp0Assert-PortalSAGWeb-RecentProductionBackup.ps1"
set "MIGRATION_SCRIPT=%~dp0Apply-PortalSAGWeb-PendingMigrationsThroughSession.ps1"
set "CLIENT_SCRIPT=%~dp0..\connect-sql-server\Invoke-PortalSAGWeb-EphemeralRequest.ps1"

echo Portal SAG Web - production migration 027
echo.
echo This launcher:
echo   1. opens one owner-authorized, memory-only SQL session;
echo   2. requires a recent full production backup;
echo   3. applies only checksum-approved pending migrations through 027;
echo   4. verifies the schema and permissions; and
echo   5. closes the SQL session.
echo.
echo No password or connection string is stored or printed.
echo.

start "Portal SAG Web - SQL authorization" pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%CONTROL_SCRIPT%" -Environment production -RequireFullControl -AllowElevatedRuntimeLogin -SessionDirectory "%SESSION_DIR%"

echo Complete the SQL prompts in the authorization window and leave it open.
echo Waiting for the authorized session...

set /a WAIT_COUNT=0
:WAIT_FOR_SESSION
if exist "%SESSION_DIR%\active.json" goto SESSION_READY
set /a WAIT_COUNT+=1
if %WAIT_COUNT% GEQ 180 goto SESSION_TIMEOUT
timeout /t 2 /nobreak >nul
goto WAIT_FOR_SESSION

:SESSION_READY
echo Authorized SQL session detected.
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%BACKUP_SCRIPT%" -SessionDirectory "%SESSION_DIR%"
if errorlevel 1 goto FAILED

pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%MIGRATION_SCRIPT%" -Environment production -SessionDirectory "%SESSION_DIR%"
if errorlevel 1 goto FAILED

pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%CLIENT_SCRIPT%" -CloseSession -SessionDirectory "%SESSION_DIR%" >nul
echo.
echo Migration 027 was applied and verified successfully.
pause
exit /b 0

:SESSION_TIMEOUT
echo.
echo Timed out waiting for SQL authorization. No migration was applied.
pause
exit /b 2

:FAILED
echo.
echo Migration 027 was not completed. Review the error above.
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%CLIENT_SCRIPT%" -CloseSession -SessionDirectory "%SESSION_DIR%" >nul 2>nul
pause
exit /b 1
