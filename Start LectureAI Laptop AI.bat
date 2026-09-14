@echo off
setlocal
cd /d "%~dp0"
title LectureAI Laptop AI

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\lectureai-runtime.ps1" -Action StartHelper
if errorlevel 1 (
  echo.
  echo Laptop AI could not start. Review .lectureai-runtime\logs and try again.
  pause
  exit /b 1
)

echo Laptop AI is running in the background. This window can close safely.
exit /b 0
