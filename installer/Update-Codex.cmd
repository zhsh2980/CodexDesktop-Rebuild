@echo off
rem ASCII only on purpose: cmd.exe parses this file with the ANSI code page (GBK on Chinese Windows).
rem All real work (and all Chinese text) lives in update.ps1, which is UTF-8 with BOM.
setlocal
rem Leave the install directory: a process whose current directory is inside it would block the folder swap.
cd /d "%TEMP%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo Update failed ^(exit code %RC%^). Please read the messages above.
    pause
)
endlocal & exit /b %RC%
