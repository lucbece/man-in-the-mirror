@echo off
setlocal enabledelayedexpansion

rem Everything ManInTheMirror.exe did, as readable text.
rem
rem The .exe is blocked from both directions: Defender won't run it and Chrome
rem won't let you download the zip containing it. Neither is being unreasonable
rem — it is an unsigned Go binary that fetches Node, unpacks it and executes
rem it, which is the behaviour signature of a dropper whatever the intent.
rem
rem This does the same three things and can be read before it is run. Node goes
rem into runtime\node, inside this folder: nothing is installed system-wide, no
rem administrator rights, and deleting the folder removes every trace.

cd /d "%~dp0"
title Man in the Mirror

set "NODE_VERSION=v24.19.0"
set "RUNTIME=%CD%\runtime"

echo.
echo   Man in the Mirror
echo   -----------------
echo.

rem --- 0. Are we actually in the project folder? ------------------------------
rem
rem Explorer lets you double-click a file inside a .zip without extracting it.
rem It copies just that file to a temp folder, flattens the names, and runs it
rem there — so the script starts in a directory with none of the project in it,
rem and the first thing to fail is npm with a module-not-found about a path
rem nobody recognises. Checking here turns that into a sentence you can act on.

if not exist "package.json" goto :notExtracted
if not exist "src\index.js" goto :notExtracted
goto :extracted

:notExtracted
echo   This isn't the project folder, so there's nothing here to start.
echo.
echo   Running from: %CD%
echo.
echo   If you double-clicked this from inside the .zip, that's the reason:
echo   Windows ran a copy of it in a temporary folder, on its own.
echo.
echo   Right-click the .zip, choose "Extract All", open the folder it makes,
echo   and double-click Start-Windows.cmd in there.
echo.
pause
exit /b 1

:extracted

rem --- 1. Find Node: on PATH, or the private copy, or fetch one ---------------

set "NODE_EXE="
set "NPM_CMD="

where node >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%v in ('node --version 2^>nul') do set "FOUND=%%v"
  echo   [1/3] Using the Node already installed ^(!FOUND!^)
  set "NODE_EXE=node"
  set "NPM_CMD=npm"
  goto :haveNode
)

if exist "%RUNTIME%\node\node.exe" (
  echo   [1/3] Using the private copy of Node in runtime\node
  set "NODE_EXE=%RUNTIME%\node\node.exe"
  set "NPM_CMD=%RUNTIME%\node\npm.cmd"
  goto :haveNode
)

rem Match the machine. PROCESSOR_ARCHITECTURE reads as x86 under a 32-bit
rem shell, in which case PROCESSOR_ARCHITEW6432 holds the real one.
set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"

set "NODE_NAME=node-%NODE_VERSION%-win-%ARCH%"
set "NODE_URL=https://nodejs.org/dist/%NODE_VERSION%/%NODE_NAME%.zip"

echo   [1/3] Node is not installed. Fetching a private copy, once.
echo         %NODE_URL%
echo         About 30MB. It goes in runtime\node and nothing else is touched.
echo.

if not exist "%RUNTIME%" mkdir "%RUNTIME%"

rem One line on purpose. Batch's ^ continuation combined with nested quotes is
rem the single most fragile construct in a file like this, and a script that
rem breaks on someone else's machine helps nobody. PowerShell strings use
rem single quotes so nothing has to be escaped through cmd.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $r='%RUNTIME%'; $zip=Join-Path $r 'node.zip'; Write-Host '        Downloading...'; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile $zip -UseBasicParsing; Write-Host '        Extracting...'; Expand-Archive -LiteralPath $zip -DestinationPath $r -Force; $src=Join-Path $r '%NODE_NAME%'; $dst=Join-Path $r 'node'; if (Test-Path $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }; Move-Item -LiteralPath $src -Destination $dst; Remove-Item -LiteralPath $zip -Force; exit 0 } catch { Write-Host ('        FAILED: ' + $_.Exception.Message); exit 1 }"

if errorlevel 1 (
  echo.
  echo   Could not fetch Node. The reason is above.
  echo.
  echo   You can install it yourself from https://nodejs.org and run this
  echo   file again — it will use whichever Node it finds.
  echo.
  pause
  exit /b 1
)

if not exist "%RUNTIME%\node\node.exe" (
  echo.
  echo   The download finished but node.exe is not where it should be.
  echo   Delete the runtime folder and try again.
  echo.
  pause
  exit /b 1
)

set "NODE_EXE=%RUNTIME%\node\node.exe"
set "NPM_CMD=%RUNTIME%\node\npm.cmd"
echo   [1/3] Node ready

:haveNode

rem --- 2. Dependencies -------------------------------------------------------

if not exist "node_modules\" (
  echo   [2/3] Installing dependencies. First run only, takes a minute...
  call "%NPM_CMD%" install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   npm install failed. The message above says why.
    pause
    exit /b 1
  )
) else (
  echo   [2/3] Dependencies already installed
)

rem --- 3. Run ----------------------------------------------------------------

echo   [3/3] Starting. The control panel opens at http://localhost:3000
echo.
echo   Close this window or press Ctrl+C to stop the bot.
echo.

rem Opened from a detached shell after a beat, so the page isn't a connection
rem error — the server needs a moment, and this must not delay starting it.
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start "" http://localhost:3000"

"%NODE_EXE%" src\index.js

echo.
echo   The bot stopped. Anything above this line is why.
pause
