@echo off
title WH-Test Server
cd /d "%~dp0"

echo ================================================
echo   WH-Test Server
echo ================================================
echo.
echo   V4:   http://localhost:8000/V4.html
echo   WH13: http://localhost:8000/WH13.html
echo.
echo DO NOT CLOSE THIS WINDOW
echo ================================================
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [!] Not running as Administrator.
    echo     Trying to restart with admin rights...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo [OK] Running as Administrator
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"

pause