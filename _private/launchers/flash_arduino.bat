@echo off
REM Upload the BioScout lamp sketch to the Arduino (close BioScout first).
cd /d "%~dp0..\.."
python tools\flash_arduino.py --check %*
pause
