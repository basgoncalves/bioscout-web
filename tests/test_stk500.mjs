/* The bundled firmware parses as Intel HEX, fits the Uno, and is the sketch
 * that has the pin tester and the analog stream (so "Update board" really
 * brings those). */
import { readFileSync } from "node:fs";
import { parseHex } from "../src/stk500.js";
let bad = 0; const ok = (c, m) => { console.log((c ? "ok    " : "FAIL  ") + m); if (!c) bad++; };
const hex = readFileSync(new URL("../assets/arduino/biofeedback_lamp/biofeedback_lamp.hex", import.meta.url), "utf8");
const img = parseHex(hex);
ok(img.length > 1000 && img.length <= 32256, `image ${img.length} bytes fits the Uno (32256 max)`);
ok(img.length % 128 === 0, "whole 128-byte pages");
const txt = Buffer.from(img).toString("latin1");
ok(txt.includes("VERSION 5"), "firmware answers V with VERSION 5 (pin tester)");
ok(txt.includes("AN_ON"), "firmware has the analog stream (A/a)");
let threw = false; try { parseHex(":0100000000FE\n"); } catch { threw = true; }
ok(threw, "a bad checksum is refused");
const ino = readFileSync(new URL("../assets/arduino/biofeedback_lamp/biofeedback_lamp.ino", import.meta.url), "utf8");
const v = (/BIOSCOUT_LAMP_READY (v\d+)/.exec(ino) || [])[1];
ok(v && txt.includes("BIOSCOUT_LAMP_READY " + v), `hex built from the current .ino (${v}) — rebuild the .hex after editing the sketch`);
console.log(bad ? `${bad} FAILED` : "ALL STK500 CHECKS PASSED"); process.exit(bad ? 1 : 0);
