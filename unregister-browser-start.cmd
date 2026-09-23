@echo off
reg delete "HKCU\Software\Classes\asin-yahoo-tool" /f >nul 2>nul
echo Unregistered asin-yahoo-tool.
pause
