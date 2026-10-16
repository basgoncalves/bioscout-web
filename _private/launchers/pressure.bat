@echo off
REM Serve BioScout Web and open BioFeedback for the Arduino pressure sensor (A0).
REM Serves whatever branch is checked out (expected: pressure-sensor).
REM Wiring: _private\arduino_server\pressure_sensor.md
REM Upload sketch v4 first with flash_arduino.bat (only once per board).
cd /d "%~dp0..\.."
for /f %%b in ('git branch --show-current') do (
  echo Branch: %%b
  if /i not "%%b"=="pressure-sensor" echo WARNING: this launcher is meant for branch "pressure-sensor" - run: git checkout pressure-sensor
)
echo In the page: Connect external device - Arduino - Choose port - Pressure sensor - Start stream
start "" "http://localhost:5173/?lab=1#viewBiofeedback"
python serve.py 5173
pause
