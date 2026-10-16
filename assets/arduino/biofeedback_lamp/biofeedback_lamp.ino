// BioScout Web - BioFeedback lamps
// The browser sends single characters over USB serial (9600 baud):
//   '1' / '0'  -> YELLOW lamp on / off  (biofeedback: the metric crossed the threshold)
//   'G' / 'g'  -> GREEN lamp on / off   (someone has BioScout open; flash or steady, set in the app)
// Wiring (see _private/arduino_server/lampsetup.md):
//   pin 13 -> 220 ohm -> yellow LED (+) ; LED (-) -> GND   (pin 13 also drives the board's "L" LED)
//   pin 8  -> 220 ohm -> green LED (+)  ; LED (-) -> GND
//   pin 7  -> relay module IN (optional, follows the yellow lamp, for a bigger lamp)
// Never drive a motor or mains lamp straight from a pin: use a relay / transistor module.
const int YELLOW_PIN = 13;
const int GREEN_PIN = 8;
const int RELAY_PIN = 7;

void setup() {
  pinMode(YELLOW_PIN, OUTPUT);
  pinMode(GREEN_PIN, OUTPUT);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(YELLOW_PIN, LOW);
  digitalWrite(GREEN_PIN, LOW);
  digitalWrite(RELAY_PIN, LOW);
  Serial.begin(9600);
  Serial.println("BIOSCOUT_LAMP_READY");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '1') { digitalWrite(YELLOW_PIN, HIGH); digitalWrite(RELAY_PIN, HIGH); Serial.println("ON"); }
    else if (c == '0') { digitalWrite(YELLOW_PIN, LOW); digitalWrite(RELAY_PIN, LOW); Serial.println("OFF"); }
    else if (c == 'G') { digitalWrite(GREEN_PIN, HIGH); Serial.println("GREEN_ON"); }
    else if (c == 'g') { digitalWrite(GREEN_PIN, LOW); Serial.println("GREEN_OFF"); }
  }
}
