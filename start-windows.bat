@echo off
REM ============================================================
REM  StoryCut - Windows launcher
REM  Is file par DOUBLE-CLICK karo, server start ho jayega.
REM  Phir browser mein kholo: http://127.0.0.1:8099
REM  Band karne ke liye bas ye window close kar do.
REM ============================================================
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  set PY=py -3
) else (
  set PY=python
)

if not exist ".venv" (
  echo [1/2] Pehli baar setup ho raha hai, thoda wait karo...
  %PY% -m venv .venv
  if errorlevel 1 (
    echo.
    echo ERROR: Python nahi mila. Pehle https://www.python.org/downloads/ se Python install karo.
    echo Install karte waqt "Add python.exe to PATH" wala tick ZAROOR lagana.
    pause
    exit /b 1
  )
)

"%~dp0.venv\Scripts\python.exe" -c "import flask" 2>nul
if errorlevel 1 (
  echo [2/2] Zaroori packages install ho rahe hain (pehli baar 2-5 minute lag sakte hain)...
  "%~dp0.venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt
)

echo.
echo ============================================================
echo  StoryCut chal raha hai!
echo  Browser mein kholo:  http://127.0.0.1:8099
echo  Band karne ke liye ye window close kar do.
echo ============================================================
echo.
"%~dp0.venv\Scripts\python.exe" -m backend.app
pause
