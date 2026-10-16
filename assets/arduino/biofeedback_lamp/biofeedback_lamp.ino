// BioScout Web - BioFeedback lamps + pressure sensor, sketch v4
// Commands over USB serial (9600 baud), one per line:
//   L0 L1 L2 L3  -> level: 0 off, 1 yellow, 2 yellow+orange, 3 yellow+orange+red
//   1 / 0        -> yellow on / off (older apps; same as L1 / L0)
//   G / g        -> GREEN lamp on / off (someone has BioScout open)
//   P<i>:<pin>   -> move lamp i to another pin and remember it (EEPROM)
//                   i: 0 yellow, 1 orange, 2 red, 3 green, 4 relay. e.g. P1:10
//   ?            -> reply with the current pins
//   S / s        -> pressure stream on / off: "F <0-1023>" from A0 at 50 Hz
//   F            -> one pressure reading now
// Pressure sensor (FSR 402 or similar) as a voltage divider on A0:
//   5V -- FSR -- A0 -- 10 kohm -- GND   (see _private/arduino_server/pressure_sensor.md)
// Default wiring (see _private/arduino_server/lampsetup.md), each LED with its own 220 ohm:
//   pin 13 yellow, pin 12 orange, pin 11 red, pin 8 green; pin 7 relay (follows "any level on").
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
unsigned long lastF = 0;

int readFsr() {                       // mean of 4 samples (~0.5 ms) against noise
  long a = 0; for (byte i = 0; i < 4; i++) a += analogRead(FSR_PIN);
  return a / 4;
}
void sendF() { Serial.print("F "); Serial.println(readFsr()); }

bool okPin(int p) { return p >= 2 && p <= 13; }

void apply() {
  for (byte i = 0; i < 3; i++) digitalWrite(pins[i], level > i ? HIGH : LOW);
  digitalWrite(pins[3], green ? HIGH : LOW);
  digitalWrite(pins[4], level > 0 ? HIGH : LOW);
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
    if (c == 'L' && k + 1 < n) { setLevel(line[k + 1] - '0'); k++; }
    else if (c == '1') setLevel(1);
    else if (c == '0') setLevel(0);
    else if (c == 'G') { green = true; apply(); Serial.println("GREEN_ON"); }
    else if (c == 'g') { green = false; apply(); Serial.println("GREEN_OFF"); }
    else if (c == '?') report();
    else if (c == 'S') { streaming = true; Serial.println("STREAM_ON"); }
    else if (c == 's') { streaming = false; Serial.println("STREAM_OFF"); }
    else if (c == 'F') sendF();
  }
  n = 0;
}

void setup() {
  bool saved = EEPROM.read(5) == MAGIC;
  for (byte i = 0; i < 5; i++) {
    byte p = saved ? EEPROM.read(i) : DEF[i];
    pins[i] = okPin(p) ? p : DEF[i];
    pinMode(pins[i], OUTPUT); digitalWrite(pins[i], LOW);
  }
  Serial.begin(9600);
  Serial.println("BIOSCOUT_LAMP_READY v4 FSR");
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
}
