@echo off
setlocal
cd /d "%~dp0"

rem Keep electron in GUI mode. Some host shells export ELECTRON_RUN_AS_NODE=1,
rem which would make electron.exe behave like plain node and exit instantly.
set ELECTRON_RUN_AS_NODE=

set "ELECTRON=node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" goto INSTALL
goto RUN

:INSTALL
echo [1/2] First run - installing dependencies, please wait...
where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] npm not found in PATH.
  echo         Install Node.js first, or run "npm install" manually in this folder.
  pause
  exit /b 1
)
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo [ERROR] npm install failed. Check your network, then retry.
  pause
  exit /b 1
)
if not exist "%ELECTRON%" (
  echo.
  echo [ERROR] electron.exe still missing after install.
  pause
  exit /b 1
)

:RUN
rem P1-D self-heal: vendor\python is git-ignored, so a fresh clone does not have
rem it and "mobile env" would fall back to system Python (or be unavailable).
rem Fetch it once, quietly; never block the app from starting because of it.
if exist "vendor\python\python.exe" goto RUN_NOW
if not exist "tools\fetch-runtime.js" goto RUN_NOW
echo [info] Bundled Python runtime missing (vendor\python) - fetching once...
where node >nul 2>nul
if errorlevel 1 (
  echo [warn] node not found. "Mobile env" will use system Python if present.
  echo        Run "npm run runtime" later to fetch the bundled runtime.
  goto RUN_NOW
)
call node tools\fetch-runtime.js
if errorlevel 1 (
  echo [warn] Fetch failed. "Mobile env" will use system Python if present.
  echo        Check network and run "npm run runtime" later.
)

:RUN_NOW
if "%~1"=="" (
  start "" "%ELECTRON%" .
  exit /b 0
)

rem Arguments passed through -> run in foreground so output stays visible.
"%ELECTRON%" . %*
exit /b %errorlevel%
