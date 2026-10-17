/* Multi-player tracking: identities survive the model shuffling its bodies,
 * a fifth body gets no number, and strokes / distance are counted per player. */
import { createMultiTracker, MAX_PLAYERS } from "../src/multiplayer.js";
let bad = 0;
const ok = (c, m) => { console.log(`  [${c ? "OK  " : "FAIL"}] ${m}`); if (!c) bad++; };
function body(x, i, swing) {
  const a = Array.from({ length: 33 }, () => ({ x, y: 0.5, visibility: 1 }));
  const fx = x + 0.0008 * i * (1 + (i % 2 ? 0 : 0)) * 8;
  a[0] = { x: fx, y: 0.2, visibility: 1 }; a[27] = a[28] = { x: fx, y: 0.8, visibility: 1 };
  a[11] = { x: fx - 0.02, y: 0.35, visibility: 1 }; a[12] = { x: fx + 0.02, y: 0.35, visibility: 1 };
  a[16] = { x: fx + (swing && i % 30 < 4 ? 0.06 * (i % 30) : 0), y: 0.5, visibility: 1 };
  return a;
}
const t = createMultiTracker();
for (let i = 0; i < 150; i++) {
  const xs = [0.1, 0.3, 0.5, 0.7, 0.9].map((x, k) => body(x, i, k === 0));
  if (i % 2) xs.reverse();                   // the model's order is not stable
  t.update(xs, i * 33.3, 1280, 720);
}
const s = t.summary();
ok(s.length === MAX_PLAYERS, "four players, the fifth body ignored");
ok(s.map((r) => r.id).join() === "1,2,3,4", "numbered 1-4");
ok(s.every((r) => r.distance_m > 0.5), "each moved and it counted distance");
const swinger = s.find((r) => r.strokes > 0);
ok(swinger && swinger.strokes === 5 && s.filter((r) => r.strokes).length === 1, "only the swinging player has strokes (5)");
console.log(bad ? `\n${bad} FAILED` : "\nAll checks passed");
process.exitCode = bad ? 1 : 0;
