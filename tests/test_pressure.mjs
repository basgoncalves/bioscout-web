// Pressure sensor parsing and lamp levels (src/pressure.js).
import assert from "node:assert/strict";
import { parseF, pressureLevel } from "../src/pressure.js";

assert.equal(parseF("F 0"), 0);
assert.equal(parseF("F 1023"), 1023);
assert.equal(parseF("F 4000"), 1023);
assert.equal(parseF("PINS 13,12,11,8,7"), null);
assert.equal(parseF("GREEN_ON"), null);

const T = [30, 60, 90];
assert.equal(pressureLevel(NaN, T), 0);
assert.equal(pressureLevel(10, T), 0);
assert.equal(pressureLevel(30, T), 1);
assert.equal(pressureLevel(65, T), 2);
assert.equal(pressureLevel(95, T), 3);
assert.equal(pressureLevel(58, T, 2), 2, "hysteresis keeps level 2 just below 60");
assert.equal(pressureLevel(56, T, 2), 1, "drops once 3 % below");
assert.equal(pressureLevel(58, T, 1), 1, "no hysteresis on the way up");
console.log("test_pressure ok");
