@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-browser-start.ps1"
echo.
echo Bookmark URL:
echo asin-yahoo-tool://start
pause
