@echo off
setlocal
cd /d "%~dp0"

rem Python is resolved at run time (see python-env.bat). No absolute paths.
call "%~dp0python-env.bat"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

"%PYEXE%" %PYARG% "%~dp0run_proxy.py" --remove-ca
echo.
echo [done] local root certificate removed.
pause
