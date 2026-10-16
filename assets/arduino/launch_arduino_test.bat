@echo off
REM Serve BioScout Web locally and open it (camera + Arduino work on localhost).
cd /d C:\Git\bioscout_web
start "" "http://localhost:5173/?lab=1#viewBiofeedback"
python serve.py 5173
pause
