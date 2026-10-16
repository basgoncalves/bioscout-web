"""Compile and upload the BioScout lamp sketch to a connected Arduino Uno.

    python tools/flash_arduino.py            # find the Uno, compile, upload
    python tools/flash_arduino.py --port COM5
    python tools/flash_arduino.py --check    # upload, then send G/g and wait for GREEN_ON

Needs arduino-cli (one-off install:  winget install ArduinoSA.CLI ). The first
run also installs the AVR core (arduino:avr) automatically.
Close BioScout (or press Disconnect) first: only one program can hold the port.
"""
import argparse, json, os, shutil, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKETCH = os.path.join(ROOT, "assets", "arduino", "biofeedback_lamp")
FQBN = "arduino:avr:uno"


def cli():
    exe = shutil.which("arduino-cli")
    if exe:
        return exe
    for p in [r"C:\Program Files\Arduino CLI\arduino-cli.exe",
              os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links\arduino-cli.exe")]:
        if os.path.exists(p):
            return p
    sys.exit("arduino-cli not found. Install it once with:  winget install ArduinoSA.CLI  (then open a new terminal)")


def run(*args, capture=False):
    print(">", " ".join(args[1:]))
    r = subprocess.run(args, text=True, capture_output=capture)
    if r.returncode:
        if capture:
            print(r.stdout, r.stderr)
        sys.exit(f"failed: {' '.join(args[1:])}")
    return r.stdout


def find_port(exe):
    data = json.loads(run(exe, "board", "list", "--format", "json", capture=True) or "[]")
    ports = data.get("detected_ports", data) if isinstance(data, dict) else data
    cands = []
    for p in ports:
        port = p.get("port", {})
        boards = p.get("matching_boards") or []
        name = boards[0].get("name", "") if boards else ""
        if port.get("protocol") == "serial":
            cands.append((port.get("address"), name))
    unos = [c for c in cands if "uno" in c[1].lower()]
    pick = unos or cands  # clones (CH340, e.g. Elegoo) often show no board name
    if not pick:
        sys.exit("No serial board found. Is the USB cable in?")
    if len(pick) > 1:
        print("Several ports:", ", ".join(f"{a} {n}" for a, n in pick), "-> using", pick[0][0], "(pass --port to choose)")
    return pick[0][0]


def check(port):
    try:
        import serial  # pyserial
    except ImportError:
        print("(skip --check: pip install pyserial)")
        return
    with serial.Serial(port, 9600, timeout=1) as s:
        time.sleep(2.5)  # the Uno resets when the port opens
        s.reset_input_buffer()
        s.write(b"G\n"); time.sleep(0.4)
        got = s.read(200).decode(errors="ignore")
        s.write(b"g\n")
    print("board replied:", got.strip() or "(nothing)")
    print("OK - green lamp sketch is running" if "GREEN_ON" in got else "No GREEN_ON: upload did not take")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    exe = cli()
    cores = run(exe, "core", "list", capture=True)
    if "arduino:avr" not in cores:
        run(exe, "core", "update-index")
        run(exe, "core", "install", "arduino:avr")
    port = a.port or find_port(exe)
    run(exe, "compile", "--fqbn", FQBN, SKETCH)
    run(exe, "upload", "-p", port, "--fqbn", FQBN, SKETCH)
    print(f"Uploaded {os.path.basename(SKETCH)} to {port}.")
    if a.check:
        check(port)


if __name__ == "__main__":
    main()
