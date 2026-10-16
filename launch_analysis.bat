@echo off
REM Serve BioScout Web locally and open the Analysis page (statistics, reliability, SPM).
REM It serves whatever branch is checked out in C:\Git\bioscout_web.
cd /d C:\Git\bioscout_web
for /f %%b in ('git branch --show-current') do echo Branch: %%b
start "" "http://localhost:5173/?lab=1#viewAnalysis"
python serve.py 5173
pause
