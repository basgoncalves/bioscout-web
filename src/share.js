/**
 * share.js -- the numbers on a shareable card, and where they go.
 *
 * Split from the drawing so the part that can be wrong can be tested. The
 * canvas work is a browser thing; deciding what a month adds up to is not.
 *
 * What is deliberately NOT on the card: cycle days, diary notes, moods,
 * symptoms and photos. A share sheet is one tap from a public post, and the
 * cost of a mistake is not symmetric -- training volume in the wrong place is
 * a shrug, a cycle in the wrong place is not. Training and intake go on it
 * because those are what people mean by a training card; the rest stays in
 * the app.
 */

/** Instagram's portrait aspect, which is what a share sheet mostly feeds. */
export const CARD = { w: 1080, h: 1350 };

/** Where the app lives -- sent along with anything shared outside it, so the
 * person who gets the picture on WhatsApp can open BioScout from it. */
export const APP_URL = "https://basgoncalves.github.io/bioscout-web/";

/**
 * The words that go with a shared picture: the caption, then a line with the
 * link. The link rides in `text` rather than `url` because with a file
 * attached several apps (WhatsApp among them) keep the text and drop the url.
 * The link line is not repeated when the caption already has the link.
 */
export function shareText(caption, linkLine) {
  const c = String(caption || "").trim();
  const l = String(linkLine || "").trim();
  if (!l || c.includes(APP_URL)) return c;
  return c ? `${c}\n\n${l}` : l;
}

const round = (n, d = 0) => (Number.isFinite(n) ? +n.toFixed(d) : null);

/**
 * Everything the card shows for one athlete and one month.
 *
 * Every figure is either present or null; null means "say nothing" rather than
 * "print a zero". A card that shows 0 kcal for a month nobody logged is a
 * claim about the month, not about the logging.
 */
export function cardStats({ name, year, month, days, mealDays, weights, today = new Date() }) {
  const p = (n) => String(n).padStart(2, "0");
  const last = new Date(year, month + 1, 0).getDate();

  let sessions = new Set(), sets = 0, reps = 0, trained = 0;
  let kcalSum = 0, kcalDays = 0;
  const volume = [];
  const kg = [];

  for (let i = 1; i <= last; i++) {
    const key = `${year}-${p(month + 1)}-${p(i)}`;
    const d = days.get(key);
    if (d) {
      trained++;
      sets += d.sets.length;
      reps += d.reps;
      for (const s of d.sessions) sessions.add(s);
    }
    volume.push(d ? d.reps : 0);

    const m = mealDays.get(key);
    if (m && m.counted) { kcalSum += m.kcal; kcalDays++; }
    const w = weights.find((x) => x.day === key);
    if (w) kg.push(w.kg);
  }

  return {
    name: String(name || "").slice(0, 28),
    month: new Date(year, month, 1).toLocaleDateString([], { month: "long", year: "numeric" }),
    trained,
    sessions: sessions.size,
    sets,
    reps,
    volume,
    kcal: kcalDays ? Math.round(kcalSum / kcalDays) : null,
    kcalDays,
    weightFrom: kg.length ? round(kg[0], 1) : null,
    weightTo: kg.length ? round(kg[kg.length - 1], 1) : null,
    empty: trained === 0 && !kcalDays,
    stamp: today.toISOString().slice(0, 10),
  };
}

/**
 * Bar geometry for the volume strip.
 *
 * Scaled to the busiest day rather than a fixed ceiling, and a day with no
 * training gets a hairline rather than nothing -- a gap in a row of bars reads
 * as missing data, a flat mark reads as a rest day.
 */
export function volumeBars(volume, x, y, w, h) {
  const max = Math.max(1, ...volume);
  const n = volume.length || 1;
  const gap = Math.max(1, Math.round(w / (n * 6)));
  const bw = (w - gap * (n - 1)) / n;
  return volume.map((v, i) => {
    const bh = v ? Math.max(3, Math.round((v / max) * h)) : 2;
    return { x: Math.round(x + i * (bw + gap)), y: Math.round(y + h - bh),
             w: Math.max(1, Math.round(bw)), h: bh, empty: !v };
  });
}

/** Split a name that will not fit, rather than letting it run off the card. */
export function fitName(name, max = 18) {
  const s = String(name || "").trim();
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}

/* ---- drawing ----------------------------------------------------------- */

const INK = "#e9edf1", MUTED = "#8b97a3", ACCENT = "#49b39b", BG = "#0f1317", CARDBG = "#161b21";

/** Draw the card on a 1080x1350 canvas context. */
export function drawCard(ctx, s, release = "") {
  const { w, h } = CARD;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = CARDBG;
  roundRect(ctx, 48, 48, w - 96, h - 96, 44);
  ctx.fill();

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = MUTED;
  ctx.font = "500 30px system-ui, sans-serif";
  ctx.fillText("BIOSCOUT", 104, 148);

  ctx.fillStyle = INK;
  ctx.font = "700 78px system-ui, sans-serif";
  ctx.fillText(fitName(s.name), 104, 246);
  ctx.fillStyle = MUTED;
  ctx.font = "500 36px system-ui, sans-serif";
  ctx.fillText(s.month, 104, 300);

  // Three figures, because four does not read at a glance on a phone screen.
  const tiles = [
    [s.trained, "days trained"],
    [s.sessions, "sessions"],
    [s.reps, "reps"],
  ];
  tiles.forEach(([v, label], i) => {
    const x = 104 + i * 292;
    ctx.fillStyle = INK;
    ctx.font = "700 96px system-ui, sans-serif";
    ctx.fillText(String(v), x, 470);
    ctx.fillStyle = MUTED;
    ctx.font = "500 30px system-ui, sans-serif";
    ctx.fillText(label, x, 516);
  });

  ctx.fillStyle = MUTED;
  ctx.font = "500 30px system-ui, sans-serif";
  ctx.fillText("REPS PER DAY", 104, 620);
  for (const b of volumeBars(s.volume, 104, 650, w - 208, 210)) {
    ctx.fillStyle = b.empty ? "#2a3138" : ACCENT;
    ctx.fillRect(b.x, b.y, b.w, b.h);
  }

  // Only what exists. A blank line beats a zero that was never measured.
  let y = 960;
  const line = (label, value) => {
    if (value === null || value === undefined) return;
    ctx.fillStyle = MUTED;
    ctx.font = "500 32px system-ui, sans-serif";
    ctx.fillText(label, 104, y);
    ctx.fillStyle = INK;
    ctx.font = "600 40px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(value, w - 104, y);
    ctx.textAlign = "left";
    y += 74;
  };
  line("Sets", String(s.sets));
  line("Calories a day", s.kcal === null ? null : `${s.kcal} kcal`);
  line("Weight", s.weightFrom === null ? null
        : (s.weightFrom === s.weightTo ? `${s.weightTo} kg`
           : `${s.weightFrom} \u2192 ${s.weightTo} kg`));

  ctx.fillStyle = MUTED;
  ctx.font = "500 26px system-ui, sans-serif";
  ctx.fillText("A physics-informed, AI-powered bio tracker", 104, h - 130);
  ctx.fillText(`${release}  \u00b7  ${s.stamp}`, 104, h - 90);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Hand the card to the system share sheet, or download it.
 *
 * navigator.share with files is the thing that opens Instagram, WhatsApp and
 * the rest. It needs a user gesture, HTTPS, and support that iOS and desktop
 * mostly lack -- so the fallback is a download, which gets to the same place
 * with one more tap rather than failing.
 */
export async function shareCard(blob, filename, title, text = "") {
  const file = new File([blob], filename, { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, ...(text ? { text } : {}) });
      return "shared";
    } catch (err) {
      // AbortError is the person changing their mind, not a failure.
      if (err && err.name === "AbortError") return "cancelled";
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return "downloaded";
}
