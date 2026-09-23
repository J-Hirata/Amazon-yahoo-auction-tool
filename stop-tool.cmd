@echo off
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":41731" ^| findstr "LISTENING"') do taskkill /PID %%p /F
