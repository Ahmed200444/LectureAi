@echo off
setlocal
cd /d "%~dp0"
title LectureAI Maximum Accuracy

if not exist ".venv\Scripts\python.exe" (
  echo Run setup-windows.bat first.
  pause
  exit /b 1
)

set "AUDIO_FILE=%~1"
if not defined AUDIO_FILE (
  echo Drag a lecture audio file onto transcribe-lecture.bat,
  set /p "AUDIO_FILE=or paste its full path here: "
)
if not exist "%AUDIO_FILE%" (
  echo Audio file not found.
  pause
  exit /b 1
)

set "MODEL_NAME=large-v3"
echo.
echo Model choices: small [Fast], medium [Balanced], large-v3 [Maximum Accuracy]
set /p "MODEL_CHOICE=Model [large-v3]: "
if defined MODEL_CHOICE set "MODEL_NAME=%MODEL_CHOICE%"

call ".venv\Scripts\activate.bat"
python "local-ai\transcribe.py" "%AUDIO_FILE%" --model "%MODEL_NAME%"
if errorlevel 1 (
  echo.
  echo Transcription failed. The original audio was not changed or deleted.
) else (
  echo.
  echo Done. Import the new .lectureai.json file from the LectureAI lecture page.
)
pause
