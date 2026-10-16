// BioScout Web - BioFeedback lamps + pressure sensor, sketch v6
// Commands over USB serial (9600 baud), one per line:
//   L0 L1 L2 L3  -> level: 0 off, 1 yellow, 2 yellow+orange, 3 yellow+orange+red
//   1 / 0        -> yellow on / off (older apps; same as L1 / L0)
//   G / g        -> GREEN lamp on / off (someone has BioScout open)
//   P<i>:<pin>   -> move lamp i to another pin and remember it (EEPROM)
//                   i: 0 yellow, 1 orange, 2 red, 3 green, 4 relay. e.g. P1:10
//   ?            -> reply with the current pins
//   T<pin>:<0|1> -> drive any pin 2-13 directly (pin tester), e.g. T9:1 -> "PIN 9 1"
//   V            -> "VERSION 5" (so the app knows the pin tester is there)
//   A / a        -> analog inputs stream on / off: "AN v0,v1,v2,v3,v4,v5" (A0-A5, 0-1023) at 25 Hz
//   S / s        -> pressure stream on / off: "F <0-1023>" from A0 at 50 Hz
//   F            -> one pressure reading now
//   D<n>         -> 4-digit display on, showing n (-999..9999), e.g. D57
//   D            -> 4-digit display on, showing the live A0 reading
//   d            -> 4-digit display off (its pins are released)
// 4-digit display (5641AS, common cathode) through a 74HC595 - see pressure_sensor.md:
//   595 DS = pin 2, SH_CP = pin 3, ST_CP = pin 4; digits D1..D4 = pins 5, 6, 9, 10.
//   Off until the first D, so the pin tester and lamps can use those pins otherwise.
// Pressure sensor (FSR 402 or similar) as a voltage divider on A0:
//   5V -- FSR -- A0 -- 10 kohm -- GND   (see _private/arduino_server/pressure_sensor.md)
// Default wiring (see _private/arduino_server/lampsetup.md), each LED with its own 220 ohm:
//   pin 13 yellow, pin 12 orange, pin 11 red, pin 8 green.
// Never drive a motor or mains lamp straight from a pin: use a relay / transistor module.
#include <EEPROM.h>

const byte DEF[5] = {13, 12, 11, 8, 7};
const byte MAGIC = 0xB3;              // EEPROM[5] == MAGIC -> pins 0..4 are valid
byte pins[5];
byte level = 0;
bool green = false;
char line[24];
byte n = 0;
unsigned long lastRx = 0;
const byte FSR_PIN = A0;
bool streaming = false;
bool anStream = false;
unsigned long lastA = 0;
unsigned long lastF = 0;

int readFsr() {                       // mean of 4 samples (~0.5 ms) against noise
  long a = 0; for (byte i = 0; i < 4; i++) a += analogRead(FSR_PIN);
  return a / 4;
}
void sendF() { Serial.print("F "); Serial.println(readFsr()); }

// ---- 4-digit display ---------------------------------------------------
const byte SR_DATA = 2, SR_CLK = 3, SR_LATCH = 4;
const byte DIG[4] = {5, 6, 9, 10};           // D1 (left) .. D4; LOW = digit lit
// bits: Q0=a Q1=b Q2=c Q3=d Q4=e Q5=f Q6=g Q7=dp
const byte FONT[10] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F};
byte segs[4] = {0, 0, 0, 0};
byte cur = 0;
bool dispOn = false, dispRaw = true;
unsigned long lastMux = 0, lastShow = 0;

void showNumber(int v) {
  bool neg = v < 0; if (neg) v = -v; if (v > 9999) v = 9999;
  for (int i = 3; i >= 0; i--) {
    if (v == 0 && i < 3) segs[i] = 0;          // blank leading zeros
    else { segs[i] = FONT[v % 10]; v /= 10; }
  }
  if (neg) for (int i = 3; i >= 0; i--) if (!segs[i]) { segs[i] = 0x40; break; }
}
void shiftSegs(byte b) {
  digitalWrite(SR_LATCH, LOW); shiftOut(SR_DATA, SR_CLK, MSBFIRST, b); digitalWrite(SR_LATCH, HIGH);
}
void dispStart() {
  if (dispOn) return;
  dispOn = true;
  pinMode(SR_DATA, OUTPUT); pinMode(SR_CLK, OUTPUT); pinMode(SR_LATCH, OUTPUT);
  for (byte i = 0; i < 4; i++) { pinMode(DIG[i], OUTPUT); digitalWrite(DIG[i], HIGH); }
}
void dispStop() {
  if (!dispOn) return;
  shiftSegs(0); dispOn = false;
  for (byte i = 0; i < 4; i++) pinMode(DIG[i], INPUT);
  pinMode(SR_DATA, INPUT); pinMode(SR_CLK, INPUT); pinMode(SR_LATCH, INPUT);
}
void muxStep() {                               // one digit per call (every 2 ms)
  digitalWrite(DIG[cur], HIGH);
  cur = (cur + 1) & 3;
  shiftSegs(segs[cur]);
  if (segs[cur]) digitalWrite(DIG[cur], LOW);
}

bool okPin(int p) { return p >= 2 && p <= 13; }

void apply() {
  for (byte i = 0; i < 3; i++) digitalWrite(pins[i], level > i ? HIGH : LOW);
  digitalWrite(pins[3], green ? HIGH : LOW);
  // pins[4] (old "relay" slot) is no longer driven; kept so saved EEPROM layouts still load
}

void report() {
  Serial.print("PINS ");
  for (byte i = 0; i < 5; i++) { Serial.print(pins[i]); Serial.print(i < 4 ? "," : "\n"); }
}

void setLevel(byte l) {
  level = l > 3 ? 3 : l; apply();
  Serial.print("LEVEL "); Serial.println(level);
}

void handle() {
  line[n] = 0;
  for (byte k = 0; k < n; k++) {
    char c = line[k];
    if (c == 'P') {                       // P<i>:<pin>
      int i = line[k + 1] - '0'; int p = atoi(line + k + 3);
      if (i >= 0 && i <= 4 && line[k + 2] == ':' && okPin(p)) {
        digitalWrite(pins[i], LOW); pinMode(pins[i], INPUT);
        pins[i] = p; pinMode(p, OUTPUT);
        EEPROM.update(i, p); EEPROM.update(5, MAGIC);
        apply();
      }
      report(); break;
    }
    if (c == 'T') {                       // T<pin>:<0|1>  pin tester
      int p = atoi(line + k + 1); char *col = strchr(line + k, ':');
      if (okPin(p) && col) { pinMode(p, OUTPUT); digitalWrite(p, col[1] == '1' ? HIGH : LOW);
        Serial.print("PIN "); Serial.print(p); Serial.print(" "); Serial.println(col[1] == '1' ? 1 : 0); }
      break;
    }
    if (c == 'L' && k + 1 < n) { setLevel(line[k + 1] - '0'); k++; }
    else if (c == '1') setLevel(1);
    else if (c == '0') setLevel(0);
    else if (c == 'G') { green = true; apply(); Serial.println("GREEN_ON"); }
    else if (c == 'g') { green = false; apply(); Serial.println("GREEN_OFF"); }
    else if (c == '?') report();
    else if (c == 'V') Serial.println("VERSION 5");
    else if (c == 'A') { anStream = true; Serial.println("AN_ON"); }
    else if (c == 'a') { anStream = false; Serial.println("AN_OFF"); }
    else if (c == 'S') { streaming = true; Serial.println("STREAM_ON"); }
    else if (c == 's') { streaming = false; Serial.println("STREAM_OFF"); }
    else if (c == 'F') sendF();
    else if (c == 'D') {                  // D<n> or plain D
      dispStart();
      if (k + 1 < n) { dispRaw = false; showNumber(atoi(line + k + 1)); } else dispRaw = true;
      Serial.println("DISP_ON"); break;
    }
    else if (c == 'd') { dispStop(); Serial.println("DISP_OFF"); }
  }
  n = 0;
}

void setup() {
  bool saved = EEPROM.read(5) == MAGIC;
  for (byte i = 0; i < 5; i++) {
    byte p = saved ? EEPROM.read(i) : DEF[i];
    pins[i] = okPin(p) ? p : DEF[i];
    if (i < 4) { pinMode(pins[i], OUTPUT); digitalWrite(pins[i], LOW); }
  }
  Serial.begin(9600);
  Serial.println("BIOSCOUT_LAMP_READY v6 FSR DISP");
  report();
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read(); lastRx = millis();
    if (c == '\n' || c == '\r') { if (n) handle(); }
    else if (n < sizeof(line) - 1) line[n++] = c;
  }
  if (n && millis() - lastRx > 60) handle();   // Serial Monitor with "No line ending"
  if (streaming && millis() - lastF >= 20) { lastF = millis(); sendF(); }   // 50 Hz
  if (anStream && millis() - lastA >= 40) {                                 // 25 Hz, all six analog inputs
    lastA = millis(); Serial.print("AN ");
    for (byte i = 0; i < 6; i++) { Serial.print(analogRead(A0 + i)); Serial.print(i < 5 ? "," : "\n"); }
  }
  if (dispOn) {
    if (dispRaw && millis() - lastShow >= 100) { lastShow = millis(); showNumber(readFsr()); }
    if (millis() - lastMux >= 2) { lastMux = millis(); muxStep(); }
  }
}
