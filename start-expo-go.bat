@echo off
setlocal
cd /d "%~dp0expo-recorder"
title LectureAI Expo Go Launcher

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or is not on PATH.
  echo Install the current Node.js LTS release, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing the free LectureAI Expo dependencies for the first time...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo.
echo Starting LectureAI for Expo Go...
echo Keep this window open while Expo Go is loading the project.
echo Scan the QR code with your iPhone camera or Expo Go.
echo No USB cable or Apple Developer subscription is required.
echo.
call npx expo start --lan

echo.
echo LectureAI Expo server stopped.
pause
