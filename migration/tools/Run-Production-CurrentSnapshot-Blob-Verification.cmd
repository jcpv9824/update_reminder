@echo off
setlocal
title Portal SAG Web - PRODUCTION CURRENT SNAPSHOT BLOB VERIFICATION
cd /d "%~dp0"

echo This verifies the 39 current-snapshot files against the protected production Blob destination.
echo Existing matching objects are reused; no Blob is overwritten and database permissions are preserved.
echo SQL Authentication is requested in memory and no file value is printed.
echo.

pwsh.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Transfer-PortalSAGWeb-Blobs.ps1" ^
  -ServerName "data14.sagerp.co,54103" ^
  -DatabaseName "PortalSAGWeb" ^
  -Username "SAGWebDev" ^
  -RunKey 2 ^
  -SnapshotDirectory "%~dp0..\backups\cosmos-export-prod-20260722-155753" ^
  -StorageAccountName "sagwebiastorage" ^
  -ResourceGroupName "SAGWeb-IA" ^
  -BlobContainerName "portal-sag-content" ^
  -TargetEnvironment "production-stage"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Production current-snapshot Blob verification ended with error code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
