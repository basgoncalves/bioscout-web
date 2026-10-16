@echo off
REM Serve BioScout Web and open Analysis (statistics, reliability, SPM).
REM Serves whatever branch is checked out (expected: analysis).
cd /d "%~dp0..\.."
for /f %%b in ('git branch --show-current') do (
  echo Branch: %%b
  if /i not "%%b"=="analysis" echo WARNING: this launcher is meant for branch "analysis" - run: git checkout analysis
)
python serve.py 5173 --open "?lab=1#viewAnalysis"
pause
