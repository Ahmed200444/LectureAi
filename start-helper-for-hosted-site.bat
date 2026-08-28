@echo off
setlocal
cd /d "%~dp0"
title LectureAI Maximum Accuracy Helper

if not exist ".venv\Scripts\python.exe" (
  echo LectureAI local AI is not installed yet.
  echo Run setup-windows.bat first.
  pause
  exit /b 1
)

echo Starting the private Maximum Accuracy engine on 127.0.0.1:8765...
start "LectureAI Maximum Accuracy" "%~dp0.venv\Scripts\python.exe" "%~dp0local-ai\server.py"
timeout /t 3 /nobreak >nul
start "" "https://lectureai-ahmed.ahmedalkadi02.chatgpt.site"
echo.
echo The hosted LectureAI site is opening. Keep the Maximum Accuracy helper window open.
echo Audio sent to 127.0.0.1 stays on this Windows computer.
pause
