/**
 * test_presence.mjs -- the "someone is online" green lamp.
 *
 *  1. applyPresence: presence_state / presence_diff fold into the set of keys,
 *     the page's own key never counts as "someone else".
 *  2. greenCommand: flash / while / off decide the lamp.
 *  3. connectPresence against a fake WebSocket: joins the right topic with
 *     its key, tracks after the join reply, heartbeats, reports changes,
 *     reconnects after a drop.
 *  4. The Arduino sketch answers 'G'/'g' on the green pin and still '1'/'0'.
 *
 *   node tests/test_presence.mjs
 */
import { readFileSync } from "node:fs";
import { applyPresence, greenCommand, connectPresence, CHANNEL } from "../src/presence.js";

let fails = 0;
const ok = (c, m) => { if (c) console.log("ok    " + m); else { fails++; console.log("FAIL  " + m); } };

// 1 -- folding
{
  const keys = new Set();
  let c = applyPresence(keys, { event: "presence_state", payload: { me: {}, a: {} } }, "me");
  ok(c.others === 1 && c.joined.join() === "a", "presence_state: one other, self excluded");
  c = applyPresence(keys, { event: "presence_diff", payload: { joins: { b: {} }, leaves: {} } }, "me");
  ok(c.others === 2 && c.joined.join() === "b", "diff join adds b");
  c = applyPresence(keys, { event: "presence_diff", payload: { joins: { b: {} }, leaves: {} } }, "me");
  ok(c.joined.length === 0 && c.others === 2, "a repeated join of b is not new");
  c = applyPresence(keys, { event: "presence_diff", payload: { joins: {}, leaves: { a: {} } } }, "me");
  ok(c.others === 1 && c.left.join() === "a", "diff leave removes a");
  c = applyPresence(keys, { event: "presence_diff", payload: { joins: { me: {} }, leaves: {} } }, "me");
  ok(c.joined.length === 0, "own key joining is not someone new");
  ok(applyPresence(keys, { event: "phx_reply", payload: {} }, "me") === null, "other events ignored");
}

// 2 -- lamp decisions
{
  ok(greenCommand("flash", { others: 2, joined: ["x"], left: [] }).on === true, "flash: new arrival -> on");
  ok(greenCommand("flash", { others: 2, joined: ["x"], left: [] }).pulseMs > 0, "flash: with a pulse length");
  ok(greenCommand("flash", { others: 1, joined: [], left: ["x"] }).on === null, "flash: a leave changes nothing");
  ok(greenCommand("while", { others: 1, joined: [], left: [] }).on === true, "while: anyone else online -> on");
  ok(greenCommand("while", { others: 0, joined: [], left: ["x"] }).on === false, "while: nobody else -> off");
  ok(greenCommand("off", { others: 3, joined: ["x"], left: [] }).on === null, "off: never");
}

// 3 -- protocol against a fake socket
{
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.readyState = 0; sockets.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; this.onclose && this.onclose(); }
    open() { this.readyState = 1; this.onopen(); }
    recv(o) { this.onmessage({ data: JSON.stringify(o) }); }
  }
  const timers = [], intervals = [];
  const changes = [], statuses = [];
  const h = connectPresence({ url: "https://abc.supabase.co", key: "pk", id: "me", WS: FakeWS,
    onChange: (c) => changes.push(c), onStatus: (s) => statuses.push(s),
    setTimer: (f, ms) => { timers.push([f, ms]); return timers.length; }, clearTimer: () => {},
    setEvery: (f, ms) => { intervals.push([f, ms]); return intervals.length; }, clearEvery: () => {} });
  const ws = sockets[0];
  ok(ws.url === "wss://abc.supabase.co/realtime/v1/websocket?apikey=pk&vsn=1.0.0", "websocket URL from the project URL and key");
  ws.open();
  const join = ws.sent[0];
  ok(join.topic === "realtime:" + CHANNEL && join.event === "phx_join", "joins realtime:" + CHANNEL);
  ok(join.payload.config.presence.key === "me", "with its own presence key");
  ok(intervals.length === 1 && intervals[0][1] === 25000, "heartbeat every 25 s");
  intervals[0][0]();
  ok(ws.sent.some((m) => m.topic === "phoenix" && m.event === "heartbeat"), "heartbeat sent on topic phoenix");
  ws.recv({ topic: join.topic, event: "phx_reply", ref: join.ref, payload: { status: "ok" } });
  ok(statuses.includes("online"), "status online after the join reply");
  ok(ws.sent.some((m) => m.event === "presence" && m.payload.event === "track"), "tracks itself after joining");
  ws.recv({ topic: join.topic, event: "presence_state", payload: { me: { metas: [] }, v1: { metas: [] } } });
  ws.recv({ topic: join.topic, event: "presence_diff", payload: { joins: { v2: { metas: [] } }, leaves: {} } });
  ok(changes.length === 2 && changes[1].joined.join() === "v2" && changes[1].others === 2, "reports a new visitor");
  ok(h.others() === 2, "others() counts everyone but itself");
  ws.close();
  ok(statuses[statuses.length - 1] === "offline" && timers.length === 1 && timers[0][1] === 1000, "drop -> offline, reconnect in 1 s");
  timers[0][0]();
  ok(sockets.length === 2, "reconnects with a new socket");
  h.stop();
  const none = connectPresence({ url: "", key: "", WS: FakeWS });
  ok(none.others() === 0 && sockets.length === 2, "no cloud url -> no connection");
}

// 4 -- sketch
{
  const ino = readFileSync("assets/arduino/biofeedback_lamp/biofeedback_lamp.ino", "utf8");
  ok(/DEF\[5\]\s*=\s*\{\s*13,\s*12,\s*11,\s*8,\s*7\s*\}/.test(ino), "sketch v3: default pins yellow 13, orange 12, red 11, green 8, relay 7");
  ok(/c == 'G'[^\n]*green = true/.test(ino) && /c == 'g'[^\n]*green = false/.test(ino) && /GREEN_ON/.test(ino), "sketch: 'G' / 'g' switch green and answer GREEN_ON/OFF");
  ok(/c == '1'\) setLevel\(1\)/.test(ino) && /c == '0'\) setLevel\(0\)/.test(ino), "sketch: '1' / '0' still switch yellow (level 1 / 0)");
  ok(/c == 'L'/.test(ino) && /level > i \? HIGH : LOW/.test(ino), "sketch: L0-L3 light yellow, orange, red cumulatively");
  ok(/c == 'P'/.test(ino) && /EEPROM\.update/.test(ino) && /okPin/.test(ino), "sketch: P<i>:<pin> moves a lamp, checked and kept in EEPROM");
  ok(/BIOSCOUT_LAMP_READY v[3-9]/.test(ino) && /report\(\)/.test(ino), "sketch: says v3+ and reports PINS so the app can tell old from new");
  ok(/FSR/.test(ino) && /analogRead\(FSR_PIN\)/.test(ino) && /c == .S./.test(ino), "sketch v4: pressure on A0, S/s stream, READY line says FSR");
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PRESENCE TESTS PASSED");
process.exit(fails ? 1 : 0);
