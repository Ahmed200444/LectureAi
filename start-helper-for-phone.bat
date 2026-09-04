@echo off
setlocal
cd /d "%~dp0"
title LectureAI Phone Transcription Helper

if not exist ".venv\Scripts\python.exe" (
  echo LectureAI Windows setup is not installed yet.
  echo Run setup-windows.bat first, then double-click this file again.
  pause
  exit /b 1
)

echo.
echo Starting LectureAI for paired iPhone/iPad transcription...
echo.
echo IMPORTANT:
echo - Use this only on a private/trusted Wi-Fi network, such as your home network.
echo - Windows Firewall may ask whether Python can use Private networks. Allow Private networks only.
echo - Keep this window open while your phone is transcribing.
echo - The helper will print a one-time pairing code and this PC's local address.
echo.

"%~dp0.venv\Scripts\python.exe" "%~dp0local-ai\server.py" --lan

echo.
echo LectureAI phone transcription helper stopped.
pause
