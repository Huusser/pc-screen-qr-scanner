@echo off
setlocal
cd /d "%~dp0"

rem Find Python: explicit env var first, then the py launcher, then PATH.
rem Never hard-code an absolute interpreter path -- a fresh clone has different
rem paths (same lesson as proxy/python-env.bat).
set "PYCMD="
if defined QRSCAN_PYTHON set "PYCMD=%QRSCAN_PYTHON%"
if not defined PYCMD (
  where py >nul 2>nul
  if not errorlevel 1 set "PYCMD=py -3"
)
if not defined PYCMD (
  where python >nul 2>nul
  if not errorlevel 1 set "PYCMD=python"
)
if not defined PYCMD (
  echo [ERROR] Python not found. Install Python 3, or set QRSCAN_PYTHON to its full path.
  pause
  exit /b 2
)

echo Serving prototype at http://localhost:8123/index.html
start "" http://localhost:8123/index.html
%PYCMD% -m http.server 8123
exit /b %errorlevel%
