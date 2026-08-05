@echo off
setlocal

rem Plain-text alternative to ManInTheMirror.exe.
rem
rem Windows Defender blocks the .exe, and not unreasonably: it is an unsigned
rem Go binary that downloads Node from the internet, unpacks it and runs it —
rem fetch, unpack, execute is the behaviour signature of a dropper, whatever
rem the intent. A batch file can't be flagged that way, and you can read every
rem line of it before running it.
rem
rem The trade is that this one won't fetch Node for you. If it isn't installed,
rem it says so and points at the installer.

cd /d "%~dp0"
title Man in the Mirror

echo.
echo   Man in the Mirror
echo   -----------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed, or not on PATH.
  echo.
  echo   Get the LTS installer from https://nodejs.org
  echo   Then close this window, open a new one, and run this file again.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do set NODEVER=%%v
echo   [1/3] Node %NODEVER%

if not exist "node_modules\" (
  echo   [2/3] Installing dependencies. First run only, takes a minute...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   npm install failed. The message above says why.
    pause
    exit /b 1
  )
) else (
  echo   [2/3] Dependencies already installed
)

echo   [3/3] Starting. The control panel opens at http://localhost:3000
echo.
echo   Close this window or press Ctrl+C to stop the bot.
echo.

start "" "http://localhost:3000"
node src\index.js

echo.
echo   The bot stopped. Anything above this line is why.
pause
