@echo off
REM Serve BioScout Web locally (home page).
REM Serves whatever branch is checked out (expected: main).
cd /d "%~dp0..\.."
for /f %%b in ('git branch --show-current') do (
  echo Branch: %%b
  if /i not "%%b"=="main" echo WARNING: this launcher is meant for branch "main" - run: git checkout main
)
python serve.py 5173 --open ""
pause
