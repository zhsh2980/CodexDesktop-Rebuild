@echo off
REM ---------------------------------------------------------------
REM  Launch-Codex.cmd - fallback launcher for the portable build
REM
REM  You normally do NOT need this. Just run ChatGPT.exe.
REM
REM  Use this only if starting ChatGPT.exe fails with
REM      "ChatGPT failed to start."
REM      "The process has no package identity."
REM  (the message may appear localized, e.g. in Chinese)
REM
REM  Why it helps: since 26.915 the app asks Windows for a package
REM  identity when app.asar/package.json has
REM      "codexWindowsAppContainedCore": "1"
REM  A portable (unzipped) copy has no package identity, so startup
REM  fails. Our build flips that flag to "0". If a future build ever
REM  misses it, setting CODEX_CLI_PATH also disables that check,
REM  which is exactly what this script does.
REM ---------------------------------------------------------------

set "CODEX_CLI_PATH=%~dp0resources\codex.exe"

if not exist "%CODEX_CLI_PATH%" (
  echo [!] Not found: %CODEX_CLI_PATH%
  echo     Run this script from the folder that contains ChatGPT.exe.
  pause
  exit /b 1
)

if not exist "%~dp0ChatGPT.exe" (
  echo [!] Not found: %~dp0ChatGPT.exe
  pause
  exit /b 1
)

echo Starting Codex with CODEX_CLI_PATH=%CODEX_CLI_PATH%
start "" "%~dp0ChatGPT.exe"
