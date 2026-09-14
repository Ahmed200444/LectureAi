@echo off
setlocal
cd /d "%~dp0"
title Stop LectureAI

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\lectureai-runtime.ps1" -Action Stop
if errorlevel 1 (
  echo.
  echo LectureAI could not stop one of its saved background processes. Nothing outside the saved LectureAI process trees was targeted.
  pause
  exit /b 1
)

echo.
echo LectureAI background processes are stopped. Logs were preserved.
exit /b 0
