@echo off
setlocal
cd /d "%~dp0"
title LectureAI Expo Go Launcher

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\lectureai-runtime.ps1" -Action StartMetro -MetroMode lan
if errorlevel 1 (
  echo.
  echo Metro could not start. Review .lectureai-runtime\logs and try again.
  pause
  exit /b 1
)

echo Metro is running in the background. This window can close safely.
exit /b 0
