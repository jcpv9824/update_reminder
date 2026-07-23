@echo off
setlocal
title Portal SAG Web - SQL Server connection
cd /d "%~dp0"

REM Edit only these NON-SECRET connection values if the provider changes them.
REM Provider DNS name and fixed TCP port confirmed in SSMS:
set "SQL_SERVER=data14.sagerp.co,54103"
set "SQL_DATABASE=PortalSAGWeb"

REM Do NOT put the SQL username or password in this file.
REM Both credentials are requested securely after you double-click this launcher.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Connect-PortalSAGWeb.ps1" -Server "%SQL_SERVER%" -Database "%SQL_DATABASE%" %*
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo The connection check ended with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
