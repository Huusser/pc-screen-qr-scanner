@echo off
rem ============================================================================
rem Shared Python discovery for the .bat launchers in this folder.
rem Call it, do not run it:   call "%~dp0python-env.bat"
rem On success it sets PYEXE (and PYARG, e.g. "-3" for the py launcher).
rem On failure it sets PYEXE empty and returns errorlevel 1.
rem
rem Order matters: an explicit override wins so you can point the scripts at a
rem specific interpreter while debugging, then the bundled runtime (both the
rem source-tree layout and the installed layout), then the system ones.
rem Keep this file pure ASCII and CRLF: cmd.exe reads .bat in the OEM codepage.
rem ============================================================================
set "PYEXE="
set "PYARG="

rem 1) explicit override (troubleshooting: point at a real python.exe)
if defined QRSCAN_PYTHON if exist "%QRSCAN_PYTHON%" set "PYEXE=%QRSCAN_PYTHON%"

rem 2) bundled runtime, source tree:  <repo>\desktop\vendor\python\python.exe
if not defined PYEXE if exist "%~dp0..\desktop\vendor\python\python.exe" set "PYEXE=%~dp0..\desktop\vendor\python\python.exe"

rem 3) bundled runtime, installed:  <app>\resources\app.asar.unpacked\vendor\python\python.exe
if not defined PYEXE if exist "%~dp0..\app.asar.unpacked\vendor\python\python.exe" set "PYEXE=%~dp0..\app.asar.unpacked\vendor\python\python.exe"

rem 4) py launcher (preferred over bare python: bare "python" can hit the
rem    Microsoft Store stub and pop up the Store instead of running)
if not defined PYEXE (
  where py >nul 2>nul
  if not errorlevel 1 (
    set "PYEXE=py"
    set "PYARG=-3"
  )
)

rem 5) python on PATH
if not defined PYEXE (
  where python >nul 2>nul
  if not errorlevel 1 set "PYEXE=python"
)

if not defined PYEXE (
  echo [ERROR] No Python runtime found. Looked for:
  echo           %%QRSCAN_PYTHON%%
  echo           %~dp0..\desktop\vendor\python\python.exe      ^(source tree^)
  echo           %~dp0..\app.asar.unpacked\vendor\python\python.exe  ^(installed^)
  echo           py -3 ^(Windows launcher^)
  echo           python ^(on PATH^)
  echo.
  echo   The release ships its own runtime. If that folder is missing it was
  echo   probably quarantined by antivirus: restore it, or install Python 3.8+
  echo   and set QRSCAN_PYTHON to the full path of python.exe.
  exit /b 1
)

exit /b 0
