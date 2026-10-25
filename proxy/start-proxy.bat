@echo off
setlocal
cd /d "%~dp0"

rem Python is resolved at run time (bundled runtime -> py launcher -> PATH).
rem Never hard-code an absolute path here: this folder ships inside the
rem installer, and a path from the developer machine does not exist anywhere else.
call "%~dp0python-env.bat"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

echo [python] %PYEXE% %PYARG%
"%PYEXE%" %PYARG% "%~dp0run_proxy.py" %*
echo.
echo [exit] proxy stopped.
pause
