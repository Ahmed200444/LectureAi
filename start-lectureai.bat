@echo off
setlocal
cd /d "%~dp0"
title LectureAI Launcher

if not exist ".venv\Scripts\python.exe" (
  echo Run setup-windows.bat first.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo Run setup-windows.bat first.
  pause
  exit /b 1
)

echo Starting LectureAI and the private transcription helper...
start "LectureAI Local Transcription" "%~dp0.venv\Scripts\python.exe" "%~dp0local-ai\server.py"
start "LectureAI Web App" /D "%~dp0" cmd /k npm run dev
timeout /t 4 /nobreak >nul
start "" "http://localhost:3000"
echo LectureAI is opening in your browser. Keep both helper windows open while using local transcription.
exit /b 0
