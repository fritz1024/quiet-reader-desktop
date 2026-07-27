@echo off
setlocal
cd /d "%~dp0"
call npm run dev
if errorlevel 1 (
  echo.
  echo Quiet Reader development version could not start.
  pause
)
