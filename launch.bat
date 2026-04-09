@echo off
cd /d "%~dp0"
if not exist ".venv" python -m venv .venv
call .venv\Scripts\activate.bat
pip install -q -r requirements.txt
echo.
echo   AniCult Web → http://localhost:5000
echo.
python app.py
pause
