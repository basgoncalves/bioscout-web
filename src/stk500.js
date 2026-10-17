/**
 * Upload a compiled sketch (.hex) to an Arduino Uno from the browser, over
 * Web Serial, with the STK500v1 protocol the Uno's bootloader speaks.
 * No Arduino IDE, no driver: the same port the app already uses.
 *
 *   parseHex(text)                  -> Uint8Array flash image
 *   flashUno(port, hexText, {onProgress}) -> resolves when written + verified
 *
 * The board is reset by toggling DTR; optiboot (genuine Uno, most clones)
 * listens at 115200, the older ATmegaBOOT (some CH340 clones) at 57600.
 */
export function parseHex(text) {
  const mem = new Uint8Array(32768).fill(0xff);
  let max = 0, base = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line.startsWith(":")) continue;
    const b = line.slice(1).match(/../g).map((h) => parseInt(h, 16));
    if (b.reduce((a, x) => a + x, 0) & 0xff) throw new Error("hex checksum");
    const n = b[0], addr = (b[1] << 8) | b[2], type = b[3];
    if (type === 0) { for (let i = 0; i < n; i++) mem[base + addr + i] = b[4 + i]; max = Math.max(max, base + addr + n); }
    else if (type === 2) base = ((b[4] << 8) | b[5]) << 4;
    else if (type === 4) base = ((b[4] << 8) | b[5]) << 16;
    else if (type === 1) break;
  }
  return mem.slice(0, Math.ceil(max / 128) * 128);   // whole 128-byte pages, padded with 0xFF
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(port, baud, img, onProgress) {
  await port.open({ baudRate: baud });
  const w = port.writable.getWriter(), r = port.readable.getReader();
  let rx = [], reading = true;
  (async () => { try { while (reading) { const { value, done } = await r.read(); if (done) break; rx.push(...value); } } catch { /* closed */ } })();
  const cmd = async (bytes, n = 0, timeout = 500) => {
    rx = [];
    await w.write(new Uint8Array([...bytes, 0x20]));           // 0x20 = Sync_CRC_EOP
    const t0 = performance.now();
    const find = () => { for (let i = rx.length - n - 2; i >= 0; i--) if (rx[i] === 0x14 && rx[i + n + 1] === 0x10) return i; return -1; };
    let i;
    while ((i = find()) < 0 && performance.now() - t0 < timeout) await sleep(4);   // INSYNC ... OK, last one wins
    if (i < 0) throw new Error("no answer from bootloader (" + bytes[0].toString(16) + ")");
    return rx.slice(i + 1, i + 1 + n);
  };
  try {
    await port.setSignals({ dataTerminalReady: false, requestToSend: false }); await sleep(250);
    await port.setSignals({ dataTerminalReady: true, requestToSend: true }); await sleep(60);
    /* Opening the port already resets the board (DTR), and so does the toggle
     * above: a sync answer can come from the first boot just before the second
     * one starts. So: sync until two in a row answer, then read the signature,
     * and if that is lost, sync again (up to 4 rounds) instead of giving up. */
    let sig = null;
    for (let round = 0; round < 4 && !sig; round++) {
      let ok = 0;
      for (let k = 0; k < 20 && ok < 2; k++) { try { await cmd([0x30], 0, 150); ok++; } catch { ok = 0; } }
      if (ok < 2) { if (round === 0) throw new Error("no bootloader at " + baud); continue; }
      await sleep(30); rx = [];
      try { sig = await cmd([0x75], 3, 400); } catch { sig = null; await sleep(120); }
    }
    if (!sig) throw new Error("no answer from bootloader (75)");
    if (sig[0] !== 0x1e || sig[1] !== 0x95 || sig[2] !== 0x0f) throw new Error("not an ATmega328P (" + sig.map((x) => x.toString(16)).join(" ") + ")");
    await cmd([0x50]);                                          // enter programming mode
    const pages = img.length / 128;
    for (let p = 0; p < pages; p++) {
      const a = p * 128, wa = a >> 1;                           // word address
      await cmd([0x55, wa & 0xff, wa >> 8]);
      await cmd([0x64, 0, 128, 0x46, ...img.subarray(a, a + 128)], 0, 1500);
      onProgress && onProgress((p + 1) / pages * 0.8);
    }
    for (let p = 0; p < pages; p++) {                           // verify
      const a = p * 128, wa = a >> 1;
      await cmd([0x55, wa & 0xff, wa >> 8]);
      const got = await cmd([0x74, 0, 128, 0x46], 128, 1500);
      for (let i = 0; i < 128; i++) if (got[i] !== img[a + i]) throw new Error("verify failed at byte " + (a + i));
      onProgress && onProgress(0.8 + (p + 1) / pages * 0.2);
    }
    await cmd([0x51]);                                          // leave programming mode -> sketch starts
  } finally {
    reading = false;
    try { await r.cancel(); } catch { /* gone */ }
    try { r.releaseLock(); w.releaseLock(); } catch { /* gone */ }
    try { await port.close(); } catch { /* gone */ }
  }
}

export async function flashUno(port, hexText, { onProgress } = {}) {
  const img = parseHex(hexText);
  let last;
  for (const baud of [115200, 57600]) {
    try { await session(port, baud, img, onProgress); return { baud, bytes: img.length }; }
    catch (e) {                                        // lost contact: one more try at this speed, with a fresh reset
      last = e; if (!/no bootloader|no answer/.test(e.message)) throw e;
      if (/no answer/.test(e.message)) {
        await sleep(400);
        try { await session(port, baud, img, onProgress); return { baud, bytes: img.length }; } catch (e2) { last = e2; }
      }
    }
  }
  throw last;
}
