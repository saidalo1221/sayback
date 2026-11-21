@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    py -3.12 -m venv .venv
    if errorlevel 1 goto failed
)
".venv\Scripts\python.exe" -c "from engine import Transcriber" >nul 2>&1
if errorlevel 1 (
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 goto failed
)
".venv\Scripts\python.exe" app.py --open
if errorlevel 1 goto failed
exit /b 0

:failed
echo Could not start Sayback. Check the message above and make sure Python 3.12 is installed.
pause
exit /b 1
