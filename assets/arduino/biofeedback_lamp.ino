// BioScout Web - BioFeedback lamp (testing)
// The browser sends one line per change over USB serial at 9600 baud:
//   "1"  -> lamp ON  (metric crossed the threshold)
//   "0"  -> lamp OFF
// Wire a LED (+220 ohm) on pin 13, or a relay module's IN on pin 7 for a mains lamp
// (use a proper isolated relay module; never wire mains directly to the Arduino).
const int LAMP_PIN = 13;   // built-in LED on Uno/Nano
const int RELAY_PIN = 7;   // optional relay module

void setup() {
  pinMode(LAMP_PIN, OUTPUT);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(LAMP_PIN, LOW);
  digitalWrite(RELAY_PIN, LOW);
  Serial.begin(9600);
  Serial.println("BIOSCOUT_LAMP_READY");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '1') { digitalWrite(LAMP_PIN, HIGH); digitalWrite(RELAY_PIN, HIGH); Serial.println("ON"); }
    else if (c == '0') { digitalWrite(LAMP_PIN, LOW); digitalWrite(RELAY_PIN, LOW); Serial.println("OFF"); }
  }
}
