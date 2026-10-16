@echo off
REM Serve BioScout Web and open BioFeedback (camera + Arduino work on localhost).
REM Serves whatever branch is checked out (expected: biofeedback).
cd /d "%~dp0..\.."
for /f %%b in ('git branch --show-current') do (
  echo Branch: %%b
  if /i not "%%b"=="biofeedback" echo WARNING: this launcher is meant for branch "biofeedback" - run: git checkout biofeedback
)
start "" "http://localhost:5173/?lab=1#viewBiofeedback"
python serve.py 5173
pause
