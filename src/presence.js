/**
 * presence.js -- "someone has BioScout open", for the green lamp.
 *
 * Every open copy of the app joins one Supabase Realtime PRESENCE channel
 * with a random key made fresh on each page load (not stored, not linked to
 * an account or a device). Nothing is written to the database: presence
 * lives only in the Realtime server's memory while the page is open, and a
 * key disappears when its page closes. The BioFeedback page subscribes and
 * turns joins into the Arduino's green lamp.
 *
 * Plain WebSocket, Phoenix JSON protocol (vsn 1.0.0), no supabase-js:
 *   phx_join  {config: {presence: {key}, broadcast: {self: false}}}
 *   presence  {type: "presence", event: "track", payload}
 *   heartbeat on topic "phoenix" every 25 s
 * Incoming: presence_state {key: {metas}}  and  presence_diff {joins, leaves}.
 */
export const CHANNEL = "bioscout-online";
const HEARTBEAT_MS = 25000;

/** Fold one Realtime message into `keys` (a Set). Returns what changed, or null. */
export function applyPresence(keys, msg, selfKey = null) {
  if (!msg || !msg.payload) return null;
  const joined = [], left = [];
  if (msg.event === "presence_state") {
    const now = new Set(Object.keys(msg.payload));
    for (const k of now) if (!keys.has(k)) { keys.add(k); if (k !== selfKey) joined.push(k); }
    for (const k of [...keys]) if (!now.has(k)) { keys.delete(k); if (k !== selfKey) left.push(k); }
  } else if (msg.event === "presence_diff") {
    for (const k of Object.keys(msg.payload.joins || {})) if (!keys.has(k)) { keys.add(k); if (k !== selfKey) joined.push(k); }
    for (const k of Object.keys(msg.payload.leaves || {})) if (keys.has(k)) { keys.delete(k); if (k !== selfKey) left.push(k); }
  } else return null;
  const others = [...keys].filter((k) => k !== selfKey).length;
  return { others, joined, left };
}

/**
 * What the green lamp should do for one presence change.
 *   mode "flash": on for `pulseMs` when someone new arrives
 *   mode "while": on while anyone else has the app open
 *   mode "off":   nothing
 * Returns { on: true | false | null (no change), pulseMs }.
 */
export function greenCommand(mode, change, pulseMs = 3000) {
  if (!change || mode === "off") return { on: null, pulseMs: 0 };
  if (mode === "flash") return change.joined.length ? { on: true, pulseMs } : { on: null, pulseMs: 0 };
  if (mode === "while") return { on: change.others > 0, pulseMs: 0 };
  return { on: null, pulseMs: 0 };
}

/** A key nobody can trace back: random, per page load. */
export const randomKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID()
  : Math.random().toString(36).slice(2) + Date.now().toString(36));

/**
 * Join the channel (and track this page). onChange({others, joined, left})
 * and onStatus("connecting" | "online" | "offline"). Reconnects with backoff.
 * Returns { stop(), others(), key }.
 */
export function connectPresence({ url, key: apiKey, id = randomKey(), track = true,
                                  onChange = () => {}, onStatus = () => {}, WS = globalThis.WebSocket,
                                  setTimer = setTimeout, clearTimer = clearTimeout, setEvery = setInterval, clearEvery = clearInterval } = {}) {
  if (!url || !apiKey || !WS) return { stop() {}, others: () => 0, key: id };
  const wsUrl = url.replace(/^http/, "ws").replace(/\/$/, "") + `/realtime/v1/websocket?apikey=${encodeURIComponent(apiKey)}&vsn=1.0.0`;
  const topic = `realtime:${CHANNEL}`, keys = new Set();
  let ws = null, ref = 0, beat = 0, retry = 0, wait = 1000, stopped = false, joinRef = null;
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ ...o, ref: String(++ref) })); return String(ref); };
  function open() {
    if (stopped) return;
    onStatus("connecting");
    try { ws = new WS(wsUrl); } catch { schedule(); return; }
    ws.onopen = () => {
      wait = 1000;
      joinRef = send({ topic, event: "phx_join", payload: { config: { broadcast: { self: false }, presence: { key: id }, postgres_changes: [], private: false } } });
      beat = setEvery(() => send({ topic: "phoenix", event: "heartbeat", payload: {} }), HEARTBEAT_MS);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.event === "phx_reply" && m.ref === joinRef) {
        if (m.payload && m.payload.status === "ok") {
          onStatus("online");
          if (track) send({ topic, event: "presence", payload: { type: "presence", event: "track", payload: { t: Date.now() } } });
        } else onStatus("offline");
        return;
      }
      const ch = applyPresence(keys, m, id);
      if (ch) onChange(ch);
    };
    ws.onclose = () => { clearEvery(beat); if (!stopped) { onStatus("offline"); keys.clear(); schedule(); } };
    ws.onerror = () => { try { ws.close(); } catch { /* closing */ } };
  }
  function schedule() { clearTimer(retry); retry = setTimer(open, wait); wait = Math.min(60000, wait * 2); }
  open();
  return {
    key: id,
    others: () => [...keys].filter((k) => k !== id).length,
    stop() { stopped = true; clearTimer(retry); clearEvery(beat); try { ws && ws.close(); } catch { /* gone */ } },
  };
}

/* One connection per page, shared by whoever wants it (the app tracks itself;
 * BioFeedback listens). */
let hub = null;
const subs = new Set();
let last = { others: 0, joined: [], left: [] }, status = "offline";
export function startPresence(cfg) {
  if (hub) return hub;
  hub = connectPresence({ ...cfg,
    onChange: (c) => { last = c; for (const f of subs) f({ type: "change", ...c }); },
    onStatus: (s) => { status = s; for (const f of subs) f({ type: "status", status: s, others: last.others }); } });
  return hub;
}
export function onPresence(fn) { subs.add(fn); fn({ type: "status", status, others: last.others }); return () => subs.delete(fn); }
