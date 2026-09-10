/**
 * The Help & chat matcher (src/help.js): questions land on the right answer
 * in all three languages, data answers read the log correctly, and every key
 * the chat can print exists.
 *
 * A keyword matcher fails quietly -- a new keyword steals questions from an
 * older intent and every answer still reads fine on its own. The question
 * list below is the guard: add the question that went wrong, then fix it.
 *
 *   node tests/test_help.mjs
 */
import { readFileSync } from "node:fs";
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
Object.defineProperty(globalThis, "navigator", { value: { languages: ["en"] }, configurable: true });
const i18n = await import("../src/i18n.js");
const H = await import("../src/help.js");

let bad = 0;
const ok = (cond, msg) => { if (!cond) { bad++; console.log("  [FAIL] " + msg); } };

/* ---- routing ----------------------------------------------------------- */
const CASES = {
  reps: ["How many squats this week?", "how many pull-ups have I done", "reps today",
         "Quantos agachamentos esta semana?", "quantas elevações na barra fiz este mês",
         "Wie viele Kniebeugen diese Woche?", "wie viele Klimmzüge habe ich gemacht"],
  sessions: ["How many sessions this month?", "how many times did I train last week",
             "quantas sessões este mês", "Wie viele Einheiten diesen Monat?"],
  streak: ["What's my streak?", "how many days in a row", "Qual é a minha sequência?",
           "Wie lang ist meine Serie?"],
  last: ["When was my last session?", "last workout", "qual foi a minha última sessão",
         "Wann war meine letzte Einheit?"],
  jump: ["My best jump", "what's my highest jump", "O meu melhor salto", "Mein bester Sprung",
         "best countermovement jump this month"],
  badges: ["How many badges do I have?", "my achievements", "as minhas conquistas",
           "meine Abzeichen"],
  weight: ["What's my weight?", "my last weight", "qual é o meu peso", "Mein Gewicht"],
  contact: ["I want to talk to a professional", "can I speak to a real person?",
            "quero falar com um profissional", "Kann ich mit einer Fachkraft sprechen?"],
  faq_medical: ["My knee hurts when I squat", "is this an injury risk?", "tenho dor no joelho",
                "Ich habe Schmerzen im Knie"],
  faq_record: ["How do I record?", "how do I record a squat", "where should I put the camera",
               "Como gravo?", "como gravar um agachamento", "Wie nehme ich auf?",
               "Wo stelle ich die Kamera hin?"],
  faq_movements: ["Which exercises are supported?", "que exercícios existem",
                  "welche Übungen gibt es"],
  faq_video: ["Can I upload a video file?", "posso analisar um vídeo da galeria",
              "Kann ich eine Videodatei hochladen?"],
  faq_privacy: ["Is my data private?", "who can see my data", "Os meus dados são privados?",
                "Sind meine Daten privat?"],
  faq_account: ["How do I sync to another device?", "como crio uma conta",
                "Wie melde ich mich an?"],
  faq_export: ["How do I export my data?", "backup before a new phone", "como exportar",
               "Wie exportiere ich meine Daten?"],
  faq_delete: ["How do I delete my account?", "como apagar a minha conta",
               "Wie kann ich mein Konto löschen?"],
  faq_accuracy: ["How accurate is it?", "can I trust the numbers", "Quão exato é?",
                 "Wie genau ist das?"],
  faq_forces: ["What do the muscle forces mean?", "what is the knee moment",
               "o que significam as forças", "Was bedeuten die Kräfte?"],
  faq_jumphow: ["How is jump height measured?", "como é calculada a altura do salto",
                "Wie wird die Sprunghöhe berechnet?"],
  faq_removerep: ["How do I remove a rep?", "it counted a wrong rep", "como retirar uma repetição",
                  "Wie kann ich eine Wiederholung entfernen?"],
  faq_assess: ["What is the physical assessment?", "o que é a avaliação física",
               "Was ist die körperliche Testung?"],
  faq_meals: ["How do I log a meal?", "how do I track water", "como registo uma refeição",
              "Wie trage ich eine Mahlzeit ein?"],
  faq_strava: ["Can I import from Strava?", "posso ligar o strava", "Strava verbinden"],
  faq_settings: ["How do I change the language?", "dark mode", "mudar o idioma",
                 "Sprache ändern"],
  faq_basketball: ["How do I mark a made shot?", "basketball", "Basquetebol",
                   "Wie markiere ich einen Treffer?"],
  faq_install: ["Can I install it?", "does it work offline", "como instalar",
                "Funktioniert es offline?"],
  faq_mass: ["Why does my body mass matter?", "onde mudo a altura", "Wo ändere ich meine Körpergröße?"],
  faq_about: ["What can you do?", "are you an AI?", "o que sabes fazer", "Was kannst du?"],
  faq_hello: ["hello", "Olá", "Hallo"],
  faq_thanks: ["thanks!", "obrigado", "danke"],
};
for (const [want, qs] of Object.entries(CASES)) {
  for (const q of qs) {
    const got = H.matchIntent(q);
    ok(got && got.id === want, `"${q}" -> ${got ? got.id + " (" + got.score + ")" : "nothing"}, wanted ${want}`);
  }
}
for (const q of ["asdf qwerty", "", "the weather in Vienna tomorrow"]) {
  ok(H.matchIntent(q) === null, `"${q}" should match nothing, got ${JSON.stringify(H.matchIntent(q))}`);
}

/* Every suggestion chip, in every language, answers what it promises. */
for (const lang of i18n.ALL_LANGS) {
  i18n.setLang(lang);
  for (const s of H.SUGGESTIONS) {
    const q = i18n.t(s.key), got = H.matchIntent(q);
    ok(got && got.id === s.want, `${lang} chip "${q}" -> ${got && got.id}, wanted ${s.want}`);
  }
}

/* ---- movements and windows --------------------------------------------- */
ok(H.findMovement("squat jumps") === "sj", "squat jump beats squat");
ok(H.findMovement("single-leg squat") === "slsquat", "single-leg squat beats squat");
ok(H.findMovement("salto sem contramovimento") === "sj", "PT sj beats cmj");
ok(H.findMovement("Klimmzüge") === "pullup", "Klimmzüge");
ok(H.findMovement("dipping into it") === null, "dip needs a whole word");
const NOW = new Date(2026, 8, 10, 15, 0);          // Thursday 10 Sep 2026
const wk = H.parseWindow("this week", NOW);
ok(wk.id === "week" && wk.from.getDate() === 7, "week starts Monday 7 Sep");
const lw = H.parseWindow("semana passada", NOW);
ok(lw.id === "lastweek" && lw.from.getDate() === 31 && lw.to.getDate() === 7, "last week 31 Aug..7 Sep");
ok(H.parseWindow("o mesmo de sempre", NOW).id === "all", "'mesmo' is not 'mes'");
ok(H.parseWindow("squats", NOW) === null, "no window named");

/* ---- data answers ------------------------------------------------------ */
i18n.setLang("en");
const iso = (d, h = 10) => new Date(2026, 8, d, h).toISOString();
const ctx = {
  tr: i18n.t, lang: "en", now: NOW, profile: "Bas",
  sessions: [
    { started: iso(1), profile: "Bas", sets: [
      { at: iso(1), activity: "squat", reps: 10, perRep: [] }] },
    { started: iso(8), profile: "Bas", sets: [
      { at: iso(8), activity: "squat", reps: 12, perRep: [] },
      { at: iso(8, 11), activity: "cmj", reps: 2,
        perRep: [{ rep: 1, height_flight_m: 0.312 }, { rep: 2, height_flight_m: 0.298 }] }] },
    { started: iso(9), profile: "Bas", sets: [{ at: iso(9), activity: "pullup", reps: 5, perRep: [] }] },
    { started: iso(10), profile: "Bas", sets: [{ at: iso(10), activity: "squat", reps: 8, perRep: [] }] },
  ],
  ledger: [{ s: new Date(2026, 5, 1).toISOString(), p: "Bas", r: { squat: 80 } },
           { s: new Date(2026, 5, 2).toISOString(), p: "Gwen", r: { squat: 500 } }],
  cardio: [{ at: iso(9, 18), profile: "Bas" }],
  weights: [{ at: iso(2), kg: 83 }, { at: iso(9), kg: 82.4 }],
};
const say = (q) => H.reply(q, ctx);
let r = say("How many squats this week?");
ok(r.intent === "reps" && r.text.includes("20 reps") && r.text.includes("2 sessions"), "week squats: " + r.text);
r = say("how many squats in total");
ok(r.text.includes("110 reps"), "lifetime squats incl. own ledger only: " + r.text);
r = say("reps today");
ok(r.text.includes("Squat 8"), "today: " + r.text);
r = say("how many dips this week");
ok(r.text.startsWith("Dip: nothing recorded this week"), "none: " + r.text);
r = say("How many sessions this week?");
ok(r.text.includes("3 sessions") && r.text.includes("3 days") && r.text.includes("1 activity"), "sessions: " + r.text);
r = say("What's my streak?");
ok(r.text.includes("3 days"), "streak 8-10 Sep: " + r.text);
r = say("my best jump");
ok(r.text.includes("31.2 cm") && r.text.includes("29.8 cm"), "jump: " + r.text);
r = say("my achievements");
ok(r.text.includes("2 badges") && r.text.includes("Pull-up, 5 more"), "badges: " + r.text);
r = say("what's my weight");
ok(r.text.includes("82.4 kg"), "weight: " + r.text);
r = say("When was my last session?");
ok(r.text.includes("Squat 8 reps"), "last: " + r.text);
r = say("my knee hurts");
ok(r.contact === true, "medical shows the contact card");
r = say("blorp");
ok(r.intent === null && r.contact === true, "fallback offers a person");
r = say("How do I record?");
ok(r.text.includes('"New training session"') && !r.text.includes("{"), "labels filled: " + r.text);

/* No placeholder is ever left unfilled, in any language, for any intent. */
const empty = { ...ctx, sessions: [], ledger: [], cardio: [], weights: [] };
for (const lang of i18n.ALL_LANGS) {
  i18n.setLang(lang);
  for (const qs of Object.values(CASES)) {
    for (const q of qs) for (const c of [ctx, empty]) {
      const t = H.reply(q, { ...c, lang }).text;
      ok(!/\{[a-zA-Z]+\}/.test(t), `${lang} "${q}" leaves a placeholder: ${t}`);
    }
  }
}

/* ---- keys -------------------------------------------------------------- */
const src = readFileSync("src/help.js", "utf8");
const used = new Set([...src.matchAll(/\btr\(\s*"([A-Za-z0-9_]+)"\s*[,)]/g)].map((m) => m[1]));
for (const id of H.FAQ_IDS) used.add(id);
for (const s of H.SUGGESTIONS) used.add(s.key);
for (const k of Object.values(H.LABELS)) used.add(k);
for (const w of ["ever", "today", "yesterday", "week", "lastweek", "month", "lastmonth", "year", "all"]) used.add("chat_win_" + w);
const missing = [...used].filter((k) => !(k in i18n.EN_KEYS));
ok(!missing.length, "help.js asks for keys no dictionary has: " + missing.join(", "));

const links = H.contactLinks("BioScout question", { email: "a@b.c", phone: "+43 660 123 4567" });
ok(links.email === "mailto:a@b.c?subject=BioScout%20question", "mailto " + links.email);
ok(links.whatsapp === "https://wa.me/436601234567" && links.tel === "tel:+436601234567", "phone links");
ok(H.contactLinks("x", { email: "a@b.c", phone: null }).whatsapp === null, "no phone, no WhatsApp");

console.log(bad ? `\n${bad} failure(s)` : `  [OK  ] help.js: routing, data answers, keys`);
process.exit(bad ? 1 : 0);
