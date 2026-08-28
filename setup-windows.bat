@echo off
setlocal
cd /d "%~dp0"
title LectureAI Setup

echo.
echo  LectureAI - Windows setup
echo  Local transcription only. No paid API is used.
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.11 or 3.12 is required. Install it from python.org and select "Add Python to PATH".
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required for the local web app.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating the private Python environment...
  python -m venv .venv
  if errorlevel 1 goto :failed
)

echo Installing open-source transcription dependencies...
call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip
python -m pip install -r "local-ai\requirements.txt"
if errorlevel 1 goto :failed

echo Installing the LectureAI web app...
call npm install
if errorlevel 1 goto :failed

echo.
echo Hardware detection and model selection
python "local-ai\setup_model.py"
if errorlevel 1 goto :failed

echo.
echo Setup complete. Run start-lectureai.bat for normal use.
pause
exit /b 0

:failed
echo.
echo Setup did not finish. Read the error above, then rerun this file.
pause
exit /b 1
