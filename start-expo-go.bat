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

for /f "delims=" %%V in ('node -p "try{require('./node_modules/expo/package.json').version}catch(e){''}"') do set "EXPO_VERSION=%%V"
echo %EXPO_VERSION% | findstr /b "57." >nul 2>&1
if errorlevel 1 (
  echo Installing/upgrading LectureAI dependencies for Expo Go SDK 57...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo.
echo Starting LectureAI for Expo Go SDK 57...
echo Keep this window open while Expo Go is loading the project.
echo Scan the QR code with your iPhone camera.
echo No USB cable or Apple Developer subscription is required.
echo.
call npx expo start --clear --lan

echo.
echo LectureAI Expo server stopped.
pause
