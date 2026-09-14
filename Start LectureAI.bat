@echo off
setlocal
cd /d "%~dp0"
title LectureAI Launcher

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\lectureai-runtime.ps1" -Action Launch -MetroMode lan
if errorlevel 1 (
  echo.
  echo LectureAI could not finish starting. Review the message above and the logs in .lectureai-runtime\logs.
  pause
  exit /b 1
)

echo.
echo LectureAI startup is continuing in the background. This window can close safely.
echo The QR page will open automatically when Metro and Laptop AI are healthy.
exit /b 0
