@echo off
setlocal
cd /d "%~dp0"
title LectureAI Status

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\lectureai-runtime.ps1" -Action Status
if errorlevel 1 (
  echo.
  echo LectureAI status could not be read. The saved logs remain in .lectureai-runtime\logs.
  pause
  exit /b 1
)

echo.
echo This window may be closed. It does not own or stop LectureAI services.
pause
exit /b 0
