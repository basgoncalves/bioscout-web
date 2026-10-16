# Launchers

One `.bat` per branch to test it locally at http://localhost:5173 (needs Python).
Double-click the one for the branch you have checked out; it warns if another branch is checked out.

| File | Branch | Opens |
|---|---|---|
| main.bat | main | home page |
| biofeedback.bat | biofeedback | BioFeedback (Arduino) |
| analysis.bat | analysis | Analysis |
| pressure.bat | pressure-sensor | BioFeedback with the pressure sensor on A0 (wiring: `_private/arduino_server/arduino_setup.md`) |
| flash_arduino.bat | any | uploads the lamp sketch to the Arduino, then checks the green lamp answers (needs `winget install ArduinoSA.CLI`, `pip install pyserial`) |

New branch? Copy one, rename it to `<branch>.bat`, and change the branch name and URL inside.
Launchers live only here (`_private/launchers/`) — not in the repo root. They `cd` two levels up to the repo root.
