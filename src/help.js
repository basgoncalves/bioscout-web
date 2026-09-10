/**
 * help.js -- the Help & chat screen's answers. No model, no network.
 *
 * Bas asked for "a very basic AI agent", then chose this instead once the
 * alternatives were priced: a hosted model costs money per message and sends
 * what people type (and their training) to a third party; a model downloaded
 * into the phone is hundreds of MB, needs WebGPU, and the small ones invent
 * facts -- which is the one thing this app's claim rules cannot tolerate.
 *
 * So this is a matcher. A question is normalised (lower case, accents and
 * punctuation stripped), scored against keyword lists in all three languages
 * at once (people mix them), and the best intent above zero answers it:
 *
 *   faq_*   a fixed, translated paragraph about how the app works
 *   data    a figure read from the athlete's own log on this device --
 *           reps, sessions, streak, last session, jump height, badges, weight
 *   contact the "Talk to a professional" card (CONTACT below)
 *
 * It never guesses: no match is a plain "I didn't catch that" plus the
 * suggestion chips and the contact card, not the nearest-sounding answer.
 *
 * Keywords match at the START of a word, so a stem ("record") also catches
 * "recording" and "recorded". Window words ("week", "mes") must match a
 * whole word -- "mes" would otherwise fire on "mesmo".
 *
 * Pure: no DOM, no storage. index.html passes the log in `ctx`, so
 * tests/test_help.mjs runs every question in node.
 */
import { achievements, repEvents, repUnit, TASK_ORDER } from "./achievements.js";

/* Who "Talk to a professional" reaches. One place to change it; `phone` null
 * hides the phone and WhatsApp rows. Format phone as +<country><number>. */
export const CONTACT = {
  name: "Bas Goncalves",
  email: "basilio.goncalves7@gmail.com",
  phone: null,
};

export function normalize(s) {
  return " " + String(s || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim() + " ";
}

const wholeWord = (text, kw) => text.includes(" " + kw + " ");
/* Three letters or fewer must be the whole word: "hi" is not "highest", and
 * "hell" (light, in German) is long enough that "hello" needed its own fix. */
const startsWord = (text, kw) => (kw.length <= 3 ? wholeWord(text, kw) : text.includes(" " + kw));
const PLURAL = ["", "s", "es", "n", "en"];

/* ---- movements --------------------------------------------------------- */

/* Longest keyword wins, so "squat jump" beats "squat" and "salto sem
 * contramovimento" beats "contramovimento". */
const MOVES = {
  squat: ["squat", "agachamento", "agachamentos", "kniebeuge"],
  slsquat: ["single leg squat", "one leg squat", "pistol", "agachamento unipodal",
            "agachamentos unipodais", "einbeinige kniebeuge", "einbeinkniebeuge"],
  pullup: ["pull up", "pullup", "chin up", "chinup", "elevacao na barra", "elevacoes na barra",
           "elevacoes", "barra fixa", "klimmzug", "klimmzuge", "klimmzuege"],
  dip: ["dip", "dips", "fundo", "fundos"],
  kickback: ["kick back", "kickback", "coice", "coices", "glute kick"],
  heelraise: ["heel raise", "calf raise", "tip toe", "tiptoe", "elevacoes do calcanhar",
              "elevacao do calcanhar", "calcanhar", "pontas dos pes", "fersenheben",
              "wadenheben", "zehenstand"],
  cmj: ["countermovement", "counter movement", "cmj", "salto com contramovimento",
        "contramovimento", "counter movement sprung"],
  sj: ["squat jump", "squat jumps", "salto sem contramovimento", "sj"],
  jumpshot: ["jump shot", "jumpshot", "jumpshots", "lancamento", "lancamentos", "arremesso",
             "sprungwurf", "sprungwurfe", "wurf", "wurfe", "shots", "shot"],
  sidestep: ["side step", "sidestep", "mudanca de direcao", "richtungswechsel"],
  run: ["run", "runs", "running", "jog", "jogging", "corrida", "corridas", "correr", "corri",
        "laufen", "lauf", "gelaufen"],
  walk: ["walk", "walks", "walking", "caminhada", "caminhar", "marcha", "andar", "gehen", "gang"],
  neck: ["neck", "pescoco", "nacken", "hals"],
};

/** The movement a question names, or null. Whole words (plus a plural
 *  ending) only: "dip" must not fire on "dipping into the app". */
export function findMovement(text) {
  const t = normalize(text);
  let best = null, len = 0;
  for (const [id, kws] of Object.entries(MOVES)) {
    for (const kw of kws) {
      if (kw.length > len && PLURAL.some((p) => wholeWord(t, kw + p))) { best = id; len = kw.length; }
    }
  }
  return best;
}

/* ---- time windows ------------------------------------------------------ */

const WINDOWS = [
  ["lastweek", ["last week", "previous week", "semana passada", "letzte woche", "vorige woche", "vergangene woche"]],
  ["lastmonth", ["last month", "previous month", "mes passado", "letzten monat", "letzter monat", "vorigen monat"]],
  ["today", ["today", "hoje", "heute"]],
  ["yesterday", ["yesterday", "ontem", "gestern"]],
  ["week", ["this week", "week", "semana", "woche"]],
  ["month", ["this month", "month", "mes", "monat"]],
  ["year", ["this year", "year", "ano", "jahr"]],
  ["all", ["total", "ever", "all time", "altogether", "sempre", "insgesamt", "bisher", "lifetime"]],
];

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** {id, from, to} for the first window word in the text; `to` is exclusive.
 *  Weeks start on Monday, like the calendar. null when none is named. */
export function parseWindow(text, now = new Date()) {
  const t = normalize(text);
  for (const [id, kws] of WINDOWS) {
    if (!kws.some((kw) => wholeWord(t, kw))) continue;
    const today = startOfDay(now);
    const day = (n) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
    const monday = day(-((today.getDay() + 6) % 7));
    const far = new Date(8640000000000000);
    switch (id) {
      case "today": return { id, from: today, to: day(1) };
      case "yesterday": return { id, from: day(-1), to: today };
      case "week": return { id, from: monday, to: far };
      case "lastweek": return { id, from: new Date(+monday - 7 * 864e5), to: monday };
      case "month": return { id, from: new Date(today.getFullYear(), today.getMonth(), 1), to: far };
      case "lastmonth": return { id, from: new Date(today.getFullYear(), today.getMonth() - 1, 1),
                                 to: new Date(today.getFullYear(), today.getMonth(), 1) };
      case "year": return { id, from: new Date(today.getFullYear(), 0, 1), to: far };
      default: return allTime();
    }
  }
  return null;
}
const allTime = () => ({ id: "all", from: new Date(-8640000000000000), to: new Date(8640000000000000) });
const inWin = (iso, w) => { const d = new Date(iso); return d >= w.from && d < w.to; };

/* ---- intents ----------------------------------------------------------- */

/* Keyword lists are normalised text. A multi-word keyword scores its word
 * count, so a phrase outweighs a lone word. Data intents score only when one
 * of their OWN keywords hit, and then get a bonus for a movement, a window or
 * "my" -- otherwise "how do I record a squat" would be a rep count. */
const INTENTS = [
  { id: "contact", kw: ["professional", "profesional", "human", "real person", "a person", "talk to",
      "speak to", "speak with", "contact", "coach", "physio", "certified", "profissional", "pessoa",
      "humano", "contacto", "contato", "falar com", "treinador", "fisioterapeuta", "fachkraft",
      "mensch", "kontakt", "sprechen", "trainer", "physiotherapeut", "experte", "expertin"] },
  { id: "faq_medical", kw: ["pain", "hurt", "hurts", "injur", "sore", "diagnos", "treat",
      "doctor", "medical", "risk of injury", "injury risk", "dor", "doi", "doem", "lesao", "lesoes",
      "lesionad", "medico", "diagnost", "tratament", "risco de lesao", "schmerz", "verletz",
      "tut weh", "arzt", "arztin", "medizin", "diagnose", "behandl", "verletzungsrisiko"] },
  { id: "faq_record", kw: ["record", "film", "camera", "set up the phone", "setup", "frame",
      "framing", "how do i start", "start a session", "new session", "gravar", "grava", "filmar",
      "grav", "camara", "enquadr", "comecar uma sessao", "nova sessao", "aufnehm", "nehme ich auf",
      "nehme auf", "aufnahme", "aufzeichn", "filmen", "kamera", "bildausschnitt", "neue einheit"] },
  { id: "faq_movements", kw: ["which movements", "what movements", "which exercises",
      "what exercises", "exercises", "movements", "supported", "what can it analy",
      "que movimentos", "quais movimentos", "que exercicios", "quais exercicios", "exercicios",
      "movimentos", "welche bewegungen", "welche ubungen", "ubungen", "bewegungen", "unterstutzt"] },
  { id: "faq_video", kw: ["video file", "upload", "existing video", "a video", "from my gallery",
      "gallery", "clip", "ficheiro de video", "video da galeria", "galeria", "carregar",
      "um video", "videodatei", "hochladen", "galerie", "ein video", "vorhandenes video"] },
  { id: "faq_privacy", kw: ["privacy", "private", "my data safe", "data safe", "who can see",
      "uploaded", "stored", "gdpr", "where is my data", "privacidade", "privad", "seguros",
      "quem ve", "armazenad", "rgpd", "onde ficam", "datenschutz", "privat", "gespeichert",
      "wer sieht", "dsgvo", "wo sind meine daten", "sicher"] },
  { id: "faq_account", kw: ["account", "sign in", "log in", "login", "sign up", "sync", "password",
      "other device", "another device", "conta", "entrar", "iniciar sessao", "sincroniz",
      "palavra passe", "senha", "outro dispositivo", "outro telemovel", "konto", "anmeld",
      "einlogg", "melde ich mich", "synchron", "passwort", "anderes gerat", "anderen gerat"] },
  { id: "faq_strava", kw: ["strava", "garmin", "watch", "cardio", "relogio", "uhr"] },
  { id: "faq_export", kw: ["export", "backup", "back up", "import", "new phone", "move my data",
      "transfer", "exportar", "copia de seguranca", "importar", "novo telemovel", "transferir",
      "exportier", "sicherung", "importier", "neues handy", "neues telefon", "ubertrag"] },
  { id: "faq_delete", kw: ["delete my account", "delete account", "delete my data", "erase",
      "remove my data", "apagar a minha conta", "apagar conta", "apagar os meus dados", "apagar",
      "konto loschen", "daten loschen", "meine daten loschen", "loschen"] },
  { id: "faq_accuracy", kw: ["accurate", "accuracy", "valid", "reliable", "precise", "trust",
      "how good", "correct", "exato", "exata", "precis", "fiavel", "fiaveis", "confiar", "valid",
      "genau", "zuverlass", "vertrauen", "stimmt", "korrekt"] },
  { id: "faq_forces", kw: ["force", "forces", "moment", "moments", "torque", "load on",
      "contact force", "muscle force", "newton", "forca", "forcas", "momento", "momentos",
      "carga", "kraft", "krafte", "drehmoment", "gelenkmoment", "belastung", "muskelkraft"] },
  { id: "faq_jumphow", kw: ["how is jump height", "jump height measured", "how do you measure",
      "flight time", "how is height", "measured", "calculated", "como e medid", "como e calculad",
      "tempo de voo", "medida", "wie wird", "gemessen", "berechnet", "flugzeit"] },
  { id: "faq_removerep", kw: ["remove a rep", "remove rep", "delete a rep", "delete rep",
      "wrong rep", "extra rep", "counted wrong", "miscount", "too many reps", "retirar",
      "remover repeticao", "apagar repeticao", "repeticao a mais", "contou mal",
      "wiederholung entfernen", "wiederholung loschen", "falsch gezahlt", "zu viele"] },
  { id: "faq_assess", kw: ["assessment", "physical test", "screen", "screening", "test battery",
      "avaliacao", "teste fisico", "testes", "testung", "test", "tests", "screening"] },
  { id: "faq_meals", kw: ["meal", "meals", "food", "calorie", "kcal", "eat", "water", "drink",
      "refeic", "comida", "calori", "comer", "agua", "beber", "mahlzeit", "essen", "kalorie",
      "wasser", "trinken", "lebensmittel"] },
  { id: "faq_settings", kw: ["language", "dark mode", "light mode", "theme", "colour", "color",
      "idioma", "lingua", "modo escuro", "modo claro", "tema", "cor", "sprache", "dunkel",
      "heller modus", "hellen modus", "farbe", "design"] },
  { id: "faq_basketball", kw: ["basketball", "made shot", "missed shot", "went in", "hoop",
      "basquet", "cesto", "encestou", "korb", "treffer"] },
  { id: "faq_install", kw: ["install", "home screen", "offline", "app store", "play store",
      "download the app", "instalar", "ecra inicial", "sem internet", "installier",
      "startbildschirm", "ohne internet"] },
  { id: "faq_mass", kw: ["body mass", "update my mass", "why mass", "mass", "height",
      "massa corporal", "massa", "altura", "korpermasse", "masse", "grosse", "korpergrosse"] },
  { id: "faq_about", kw: ["what can you do", "who are you", "what are you", "help", "how does this chat",
      "are you an ai", "are you ai", "chatgpt", "o que sabes", "quem es", "o que es", "ajuda",
      "es uma ia", "was kannst du", "wer bist du", "was bist du", "hilfe", "bist du eine ki"] },
  { id: "faq_hello", kw: ["hello", "hi", "hey", "good morning", "ola", "bom dia", "boa tarde",
      "hallo", "servus", "gruss gott", "guten morgen", "guten tag", "moin"] },
  { id: "faq_thanks", kw: ["thanks", "thank you", "cheers", "obrigad", "danke", "vielen dank"] },

  { id: "reps", data: true, kw: ["reps", "repetitions", "did i do", "have i done", "volume",
      "repeticoes", "repeticao", "fiz", "wiederholungen", "gemacht", "anzahl"] },
  { id: "sessions", data: true, kw: ["sessions", "session", "trained", "training days",
      "workouts", "times did i", "sessoes", "sessao", "treinei", "dias de treino", "treinos",
      "einheiten", "einheit", "trainiert", "trainingstage", "trainings"] },
  { id: "streak", data: true, kw: ["streak", "in a row", "consecutive", "sequencia", "seguidos",
      "seguidas", "serie", "in folge", "hintereinander", "am stuck"] },
  { id: "last", data: true, kw: ["last session", "last workout", "last time", "when did i last",
      "most recent", "ultima sessao", "ultimo treino", "ultima vez", "quando treinei",
      "letzte einheit", "letztes training", "letzte mal", "zuletzt"] },
  { id: "jump", data: true, kw: ["jump", "jumps", "salto", "saltos", "saltei", "sprung", "sprunge",
      "gesprungen", "vertical"] },
  { id: "badges", data: true, kw: ["badge", "badges", "achievement", "milestone", "medal",
      "trophy", "conquista", "medalha", "marco", "trofeu", "abzeichen", "erfolg", "meilenstein",
      "medaille", "pokal"] },
  { id: "weight", data: true, kw: ["weight", "weigh", "peso", "peso atual", "pesei", "gewicht",
      "wiege", "gewogen"] },
];

const MY = ["my", "me", "i", "meu", "minha", "meus", "minhas", "eu", "mein", "meine", "meinen",
            "ich", "mir", "mich"];
const BEST = ["best", "highest", "record", "max", "top", "melhor", "mais alto", "recorde",
              "maximo", "beste", "besten", "hochste", "rekord", "maximal"];
/* Asking for a figure ("how many") is not asking for instructions ("how do
 * I"): only the second kind pushes towards the FAQ. */
const COUNT = ["how many", "how much", "quant", "wie viel"];
const HOW = ["how do", "how can", "how to", "how does", "how is", "where", "como", "onde",
             "wie kann", "wie mache", "wie nehme", "wie funktioniert", "wie wird", "wie melde",
             "wie trage", "wie markiere", "wie exportiere", "wie andere", "wo"];

/** {id, score} of the best-scoring intent, or null. Exported for tests. */
export function matchIntent(text) {
  const t = normalize(text);
  if (t.trim() === "") return null;
  const move = findMovement(text);
  const win = parseWindow(text) !== null;
  const my = MY.some((w) => wholeWord(t, w));
  const count = COUNT.some((w) => startsWord(t, w));
  const how = !count && HOW.some((w) => startsWord(t, w));
  let best = null;
  for (const it of INTENTS) {
    let hits = 0;
    for (const kw of it.kw) if (startsWord(t, kw)) hits += kw.split(" ").length;
    // A bare count ("how many ... this week") is a rep question unless a more
    // specific data word -- sessions, badges -- claims it; one naming a
    // movement ("how many squats") is a rep question outright.
    let bareCount = false;
    if (it.id === "reps" && (count || win) && move) hits += 2;
    else if (it.id === "reps" && count && !hits) { hits = 1; bareCount = true; }
    if (!hits) continue;
    let score = hits;
    if (it.data) {
      if (move) score += 2;
      if (win) score += 1;
      if (my) score += 1;
      if (count && !bareCount) score += 1;
      // "best jump" is a height, not a count of jumps.
      if (it.id === "jump" && BEST.some((w) => startsWord(t, w))) score += 2;
      // "How do I ..." is asking for instructions, not a figure.
      if (how && !win) score -= 1;
    } else if (how) {
      score += 1;
    }
    if (!best || score > best.score) best = { id: it.id, score };
  }
  return best && best.score > 0 ? best : null;
}

/* ---- answers ----------------------------------------------------------- */

/* The chips under the chat. Each is an i18n key whose text, sent as a
 * question, must land on `want` in every language -- test_help.mjs checks. */
export const SUGGESTIONS = [
  { key: "chat_sug_reps", want: "reps" },
  { key: "chat_sug_streak", want: "streak" },
  { key: "chat_sug_jump", want: "jump" },
  { key: "chat_sug_record", want: "faq_record" },
  { key: "chat_sug_privacy", want: "faq_privacy" },
  { key: "chat_sug_accuracy", want: "faq_accuracy" },
];

/* Button names inside the answers are placeholders filled from the buttons'
 * own keys, so an answer can never tell someone to tap a label that was
 * renamed. {placeholder} -> i18n key. */
export const LABELS = {
  newSession: "newTrainingSession", auto: "auto", startCamera: "startCamera",
  analyseFile: "analyseFile", editProfile: "editProfile", exportData: "exportData",
  import: "import", acctDelete: "acctDelete", acctAthlete: "acctAthlete",
  removeRep: "removeRep", assess: "assess", assessFinish: "assessFinish",
  addMeal: "addMeal", yourData: "yourData", stravaImport: "stravaImport", pro: "chat_pro",
};
const labels = (tr) => Object.fromEntries(Object.entries(LABELS).map(([k, v]) => [k, tr(v)]));

/** Every FAQ intent id; each needs a translated key of the same name. */
export const FAQ_IDS = INTENTS.filter((i) => i.id.startsWith("faq_")).map((i) => i.id);

const fmtDate = (iso, lang) => {
  try {
    return new Date(iso).toLocaleDateString(lang, { weekday: "short", day: "numeric", month: "short" });
  } catch { return String(iso).slice(0, 10); }
};

/* 31,2 in Portuguese and German, 31.2 in English. */
const fmtNum = (v, digits, lang) => {
  try {
    return v.toLocaleString(lang || "en", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  } catch { return v.toFixed(digits); }
};

const localDay = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* Sessions with at least one set in `w`, plus ledger entries (sessions the
 * archive has dropped; only their start and reps per task survive). */
function sessionsIn(ctx, w, move = null) {
  const out = new Map();
  for (const s of ctx.sessions || []) {
    for (const set of s.sets || []) {
      if (move && set.activity !== move) continue;
      const at = set.at || s.started;
      if (!inWin(at, w)) continue;
      const e = out.get(s.started) || { started: s.started, days: new Set() };
      e.days.add(localDay(at));
      out.set(s.started, e);
    }
  }
  const live = new Set((ctx.sessions || []).map((s) => s.started));
  for (const e of ctx.ledger || []) {
    if (!e || !e.s || live.has(e.s) || (ctx.profile != null && e.p !== ctx.profile)) continue;
    if (move && !(+((e.r || {})[move]) > 0)) continue;
    if (!inWin(e.s, w)) continue;
    out.set(e.s, { started: e.s, days: new Set([localDay(e.s)]) });
  }
  const days = new Set();
  for (const e of out.values()) for (const d of e.days) days.add(d);
  return { sessions: out.size, days: days.size };
}

const nSess = (tr, n) => tr(n === 1 ? "chat_nSession" : "chat_nSessions", { n });

function repsAnswer(ctx, text, tr) {
  const w = parseWindow(text, ctx.now) || allTime();
  const winLabel = tr("chat_win_" + w.id);
  const move = findMovement(text);
  const ev = repEvents(ctx.sessions || [], ctx.ledger || [], ctx.profile ?? null)
    .filter((e) => inWin(e.at, w));
  if (move) {
    const n = ev.filter((e) => e.activity === move).reduce((a, e) => a + e.reps, 0);
    const moveName = tr(move);
    if (!n) return w.id === "all" ? tr("chat_repsNoneMoveEver", { move: moveName })
                                  : tr("chat_repsNoneMove", { move: moveName, win: winLabel });
    return tr("chat_repsMove", { move: moveName, win: winLabel, count: repUnit(n, move, tr),
                                 sessions: nSess(tr, sessionsIn(ctx, w, move).sessions) });
  }
  const by = new Map();
  for (const e of ev) by.set(e.activity, (by.get(e.activity) || 0) + e.reps);
  if (!by.size) return w.id === "all" ? tr("chat_repsNoneEver") : tr("chat_repsNone", { win: winLabel });
  const rank = (k) => { const i = TASK_ORDER.indexOf(k); return i < 0 ? 99 : i; };
  const list = [...by.entries()].sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0]))
    .map(([k, n]) => `${tr(k)} ${n}`).join(", ");
  return tr("chat_repsAll", { win: winLabel, list, sessions: nSess(tr, sessionsIn(ctx, w).sessions) });
}

function sessionsAnswer(ctx, text, tr) {
  const w = parseWindow(text, ctx.now) || allTime();
  const { sessions, days } = sessionsIn(ctx, w);
  const cardio = (ctx.cardio || []).filter((c) => c && c.at && inWin(c.at, w)).length;
  const winLabel = tr("chat_win_" + w.id);
  if (!sessions && !cardio) {
    return w.id === "all" ? tr("chat_sessionsNoneEver") : tr("chat_sessionsNone", { win: winLabel });
  }
  const extra = cardio ? tr("chat_plusCardio", { acts: tr(cardio === 1 ? "nActivity" : "nActivities", { n: cardio }) }) : "";
  return tr("chat_sessions", { win: winLabel, sessions: nSess(tr, sessions),
                               days: tr(days === 1 ? "nDay" : "nDays", { n: days }), extra });
}

function streakAnswer(ctx, tr) {
  const days = new Set();
  for (const s of ctx.sessions || []) for (const set of s.sets || []) days.add(localDay(set.at || s.started));
  for (const c of ctx.cardio || []) if (c && c.at) days.add(localDay(c.at));
  const now = startOfDay(ctx.now || new Date());
  const cur = new Date(now);
  if (!days.has(localDay(cur))) cur.setDate(cur.getDate() - 1);
  let n = 0;
  while (days.has(localDay(cur))) { n++; cur.setDate(cur.getDate() - 1); }
  if (!n) return tr("chat_streakNone");
  return tr("chat_streak", { days: tr(n === 1 ? "nDay" : "nDays", { n }) });
}

function lastAnswer(ctx, tr) {
  const ss = (ctx.sessions || []).filter((s) => (s.sets || []).length);
  if (!ss.length) return tr("chat_lastNone", labels(tr));
  const s = ss.reduce((a, b) => (String(b.started) > String(a.started) ? b : a));
  const by = new Map();
  for (const set of s.sets) if (set.activity) by.set(set.activity, (by.get(set.activity) || 0) + (+set.reps || 0));
  const list = [...by.entries()].map(([k, n]) => `${tr(k)} ${repUnit(n, k, tr)}`).join(", ");
  const lastAt = s.sets[s.sets.length - 1].at || s.started;
  return tr("chat_last", { date: fmtDate(lastAt, ctx.lang), sets: tr(s.sets.length === 1 ? "nSet" : "nSets", { n: s.sets.length }), list });
}

function jumpAnswer(ctx, text, tr) {
  const w = parseWindow(text, ctx.now) || allTime();
  // "Best jump in total" reads wrong; a record is "so far".
  const winLabel = tr(w.id === "all" ? "chat_win_ever" : "chat_win_" + w.id);
  const named = findMovement(text);
  const kinds = named === "cmj" || named === "sj" ? [named] : ["cmj", "sj"];
  const jumps = [];
  for (const s of ctx.sessions || []) {
    for (const set of s.sets || []) {
      if (!kinds.includes(set.activity)) continue;
      const at = set.at || s.started;
      if (!inWin(at, w)) continue;
      for (const r of set.perRep || []) {
        const h = r && +r.height_flight_m;
        if (r && !r.removed && Number.isFinite(h) && h > 0) jumps.push({ h, at, activity: set.activity });
      }
    }
  }
  if (!jumps.length) return w.id === "all" ? tr("chat_jumpNoneEver") : tr("chat_jumpNone", { win: winLabel });
  const best = jumps.reduce((a, b) => (b.h > a.h ? b : a));
  const last = jumps.reduce((a, b) => (String(b.at) >= String(a.at) ? b : a));
  const cm = (m) => fmtNum(m * 100, 1, ctx.lang);
  return tr("chat_jump", { win: winLabel, move: tr(best.activity), best: cm(best.h),
                           date: fmtDate(best.at, ctx.lang), last: cm(last.h),
                           jumps: tr(jumps.length === 1 ? "chat_nJump" : "chat_nJumps", { n: jumps.length }) });
}

function badgesAnswer(ctx, tr) {
  const list = achievements(repEvents(ctx.sessions || [], ctx.ledger || [], ctx.profile ?? null));
  const earned = list.reduce((n, a) => n + a.earned, 0);
  if (!earned) return tr("chat_badgesNone");
  const next = list.filter((a) => a.next).map((a) => ({ a, left: a.next - a.total }))
    .sort((x, y) => x.left - y.left)[0];
  const tail = next ? tr("chat_badgesNext", { move: tr(next.a.activity), left: next.left, next: next.a.next }) : "";
  return tr("chat_badges", { badges: tr(earned === 1 ? "chat_nBadge" : "chat_nBadges", { n: earned }) }) + tail;
}

function weightAnswer(ctx, tr) {
  const ws = (ctx.weights || []).filter((w) => w && Number.isFinite(+w.kg) && w.at);
  if (!ws.length) return tr("chat_weightNone");
  const w = ws.reduce((a, b) => (String(b.at) >= String(a.at) ? b : a));
  return tr("chat_weight", { kg: fmtNum(+w.kg, 1, ctx.lang), date: fmtDate(w.at, ctx.lang) });
}

/**
 * Answer one question.
 *
 * `ctx`: { tr, lang, now, profile, sessions (dashboard allSessions for this
 * athlete), ledger (listLedger), cardio (this athlete's), weights (this
 * athlete's) }. Returns { intent, text, contact } -- `contact` true means
 * show the professional card under the reply.
 */
export function reply(text, ctx) {
  const r = answer(text, ctx);
  // Templates may open on a window word ("gestern nichts aufgezeichnet").
  r.text = r.text.charAt(0).toUpperCase() + r.text.slice(1);
  return r;
}

function answer(text, ctx) {
  const tr = ctx.tr;
  const m = matchIntent(text);
  if (!m) return { intent: null, text: tr("chat_fallback"), contact: true };
  switch (m.id) {
    case "contact": return { intent: m.id, text: tr("chat_contactIntro"), contact: true };
    case "reps": return { intent: m.id, text: repsAnswer(ctx, text, tr) };
    case "sessions": return { intent: m.id, text: sessionsAnswer(ctx, text, tr) };
    case "streak": return { intent: m.id, text: streakAnswer(ctx, tr) };
    case "last": return { intent: m.id, text: lastAnswer(ctx, tr) };
    case "jump": return { intent: m.id, text: jumpAnswer(ctx, text, tr) };
    case "badges": return { intent: m.id, text: badgesAnswer(ctx, tr) };
    case "weight": return { intent: m.id, text: weightAnswer(ctx, tr) };
    case "faq_movements":
      return { intent: m.id, text: tr("faq_movements",
        { ...labels(tr), list: TASK_ORDER.map((k) => tr(k)).join(", ") }) };
    case "faq_medical": return { intent: m.id, text: tr("faq_medical", labels(tr)), contact: true };
    default: return { intent: m.id, text: tr(m.id, labels(tr)) };
  }
}

/** mailto: and WhatsApp links for the contact card. */
export function contactLinks(subject, contact = CONTACT) {
  const out = { email: null, tel: null, whatsapp: null };
  if (contact.email) out.email = `mailto:${contact.email}?subject=${encodeURIComponent(subject)}`;
  if (contact.phone) {
    const digits = String(contact.phone).replace(/[^\d+]/g, "");
    out.tel = `tel:${digits}`;
    out.whatsapp = `https://wa.me/${digits.replace(/^\+/, "")}`;
  }
  return out;
}
