@echo off
setlocal
cd /d "%~dp0"
title LectureAI QR

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\lectureai-runtime.ps1" -Action ShowQr
if errorlevel 1 (
  echo.
  echo The QR page could not be prepared. Run Start LectureAI first, then try again.
  pause
  exit /b 1
)

exit /b 0
