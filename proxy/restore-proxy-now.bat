@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo  QRScan - Restore Windows proxy settings
echo ============================================
echo.
if not exist "previous.json" (
  echo Nothing to restore. previous.json not found,
  echo which means the system proxy was not modified
  echo or it has already been restored.
  echo.
  pause
  exit /b 0
)
rem Same runtime discovery as start-proxy.bat: bundled Python first, then the
rem system one. Never hard-code an absolute path: this folder ships inside the
rem installer, where a developer-machine path does not exist.
call "%~dp0python-env.bat"
if errorlevel 1 (
  echo.
  echo Please reset the proxy manually:
  echo   Settings ^> Network ^& Internet ^> Proxy
  echo   turn OFF "Use a proxy server"
  echo.
  pause
  exit /b 1
)

"%PYEXE%" %PYARG% "%~dp0run_proxy.py" --restore
echo.
echo Finished. Please verify the proxy in Windows Settings
echo is back to how it was before.
echo.
pause
