@echo off
REM ---------------------------------------------------------------
REM  Launch-Codex.cmd - unzip-and-run launcher for the portable build
REM
REM  This is the official "no install, just run" entry point. The
REM  files in this zip (ChatGPT.exe, resources\app.asar, etc.) are
REM  byte-for-byte identical to the official Microsoft Store package,
REM  unmodified. A plain unzipped copy has no Windows "package
REM  identity" though, and the app refuses to start without one:
REM      "ChatGPT failed to start."
REM      "The process has no package identity."
REM  (the message may appear localized, e.g. in Chinese)
REM
REM  Why this script helps: at startup, the app only requires a
REM  package identity when the CODEX_CLI_PATH environment variable is
REM  empty. This script sets it (pointing at the bundled codex.exe)
REM  and then starts ChatGPT.exe, which skips that check. No file in
REM  the package is modified.
REM
REM  If you used Install-Codex.cmd instead, it already sets this
REM  variable for your user account (see HKCU\Environment), so
REM  double-clicking ChatGPT.exe directly also works afterwards -
REM  this script is only needed when running straight out of the zip.
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
