# Pressure sensor on the BioScout Arduino — wiring and use

One force-sensitive resistor (FSR) read on **A0**, streamed to the BioScout Web
**BioFeedback** page over the same USB cable as the lamps (Web Serial, Chrome / Edge).
The lamps keep their pins (13 / 12 / 11 / 8 / 7), so both work together.

Sketch: `assets/arduino/biofeedback_lamp/biofeedback_lamp.ino` (**v4**).
App code: `src/pressure.js` (wired in `src/biofeedback.js`), UI in the Arduino panel.

---

## 1. Parts

- Arduino Uno (Elegoo Uno R3 fine) + USB cable — the one already running the lamps
- 1 × FSR, e.g. **Interlink FSR 402** (round, 13 mm) or FSR 406 (square, 38 mm, for a foot/heel)
- 1 × **10 kΩ** resistor (brown-black-orange) — the pull-down
- 3 jumper wires (+ breadboard). An FSR's legs do not solder well: use a
  crimp/clincher connector or a female header.

## 2. Schematic

The FSR and the 10 kΩ form a voltage divider. No pressure → FSR ≈ open (> 1 MΩ)
→ A0 ≈ 0 V. Pressing lowers the FSR resistance → A0 rises toward 5 V.

```
        Arduino Uno
     +-------------+
     |          5V o-----------+
     |             |           |
     |             |         [FSR]      force-sensitive resistor
     |             |           |        (no polarity)
     |          A0 o-----------+
     |             |           |
     |             |        [10 kΩ]     pull-down
     |             |           |
     |         GND o-----------+
     +-------------+

     Vout(A0) = 5 V × 10k / (10k + R_fsr)        reading = Vout / 5 V × 1023
```

Breadboard layout (the lamps' LEDs stay where they are):

```
  5V  ───────────── row 10 ── FSR leg 1
                                FSR leg 2 ── row 12
  A0  ───────────────────────────────────── row 12
                                10 kΩ      ── row 12 … row 16
  GND ───────────────────────────────────── row 16
```

| Wire | From | To |
|---|---|---|
| red | Uno **5V** | FSR leg 1 |
| yellow/white | Uno **A0** | FSR leg 2 *and* one end of the 10 kΩ |
| black | Uno **GND** | other end of the 10 kΩ |

**Choosing the resistor:** 10 kΩ gives the best range for light–medium loads
(finger, hand). For a foot/heel use **3.3 kΩ** (less saturation at high force);
for a very light touch use 47–100 kΩ. Any value is safe: the max current is 5 V / R.

**Do not** connect the FSR straight between 5V and GND, and never put more than 5 V on A0.

## 3. Upload the sketch

Close BioScout (or press Disconnect), then double-click
`_private/launchers/flash_arduino.bat`. On connect the board now says
`BIOSCOUT_LAMP_READY v4 FSR`; if the app shows "no pressure sensor support",
the old v3 sketch is still on the board.

## 4. Serial protocol (9600 baud, one command per line)

| Send | Board does | Board replies |
|---|---|---|
| `S` | start streaming A0 at 50 Hz | `STREAM_ON`, then `F <0-1023>` lines |
| `s` | stop streaming | `STREAM_OFF` |
| `F` | one reading now | `F <0-1023>` |
| `L0`…`L3`, `G`/`g`, `P<i>:<pin>`, `?` | lamps, unchanged from v3 | as before |

Each reading is the mean of 4 `analogRead`s. 50 Hz × 8 bytes = 400 B/s, well
within 9600 baud, so the lamp commands are not delayed.

## 5. Use in the app

1. Start `_private/launchers/pressure.bat` (branch `pressure-sensor`), open
   BioFeedback → **Connect external device → Arduino → Choose port…**
2. Scroll to **Pressure sensor (A0)** → **Start stream**. The number, bar and 10 s trace move.
3. With nothing on the sensor press **Set zero**; press as hard as the task will
   → **Set max**. The % is now relative to that range (kept in this browser).
4. Tick **Lamps follow pressure** and set **Levels (%)**, e.g. `30, 60, 90` →
   yellow / orange / red. While ticked the camera metric does not drive the lamp.
5. **Download CSV** saves `t_ms, raw, pct` for everything streamed since connecting.

## 6. What it is and is not

- An FSR is **non-linear**, has ~±10–25 % part-to-part spread, and creeps under
  a constant load. The app therefore shows raw counts and % of your own range —
  **not newtons**. For force in N, calibrate against known weights per sensor
  (fit a power law `F = a·raw^b`) or use a load cell + HX711 instead.
- Good for: on/off contact, timing (heel strike, grip on/off), relative
  "push harder / ease off" biofeedback.

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| Always ~0 | 5V wire missing, or FSR leg not making contact in the breadboard |
| Always ~1023 | 10 kΩ missing (A0 floating high) or FSR shorted |
| Jumps around with no touch | A0 floating — the 10 kΩ to GND is missing |
| Saturates at light press | use a smaller resistor (3.3 kΩ) |
| App: "no pressure sensor support" | upload sketch v4 |
