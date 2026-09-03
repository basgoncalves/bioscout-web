/**
 * i18n.js -- interface language.
 *
 * Scope is deliberate: the interface and the warnings you are meant to ACT on
 * are translated; the long methodological notes are not. Those notes are where
 * a mistranslation does real damage -- they are the ones saying which numbers
 * to distrust and why -- and three copies of every caveat would drift apart as
 * the code changes. One authoritative wording beats three uncertain ones.
 *
 * Missing keys fall through to English rather than showing a key name, so a
 * half-finished translation degrades into a mixed page instead of gibberish.
 * `missingKeys()` lists what has not been translated, and the test suite fails
 * on a key that exists in a translation but no longer exists in English --
 * that is the one that rots silently.
 */
const LKEY = "bioscout.lang.v1";

export const LANGUAGES = { en: "English", pt: "Português", de: "Deutsch" };

const EN = {
  // --- athlete -------------------------------------------------------------
  "athlete": "Athlete",
  "noProfile": "— no profile —",
  "name": "Name",
  "height": "Height (m)",
  "dob": "Date of birth",
  "mass": "Mass (kg)",
  "years": "years",
  "saveProfile": "Save profile",
  "delete": "Delete",
  "exportData": "Export my data",
  "import": "Import",
  "language": "Language",
  // --- recording settings --------------------------------------------------
  "movement": "Movement",
  "auto": "Detect automatically",
  "pullup": "Pull-up",
  "squat": "Squat",
  "cmj": "Countermovement jump",
  "sj": "Squat jump",
  "neck": "Neck (close-up)",
  "addedLoad": "Added load (kg)",
  "assistance": "Assistance (kg)",
  "overlay": "Skeleton overlay",
  "overlayNone": "None — landmarks only",
  "headSize": "Head size",
  "keepVideo": "Also keep the video in the export",
  "startCamera": "Start camera",
  "analyseFile": "Analyse a video file",
  "startRecording": "Start recording",
  "stopRecording": "Stop recording",
  "switchCamera": "Switch camera",
  "closeCamera": "Close camera",
  // --- results -------------------------------------------------------------
  "showing": "Showing",
  "set": "Set",
  "rep": "Rep",
  "jump": "Jump",
  "mean": "Mean",
  "reps": "Reps",
  "load": "Load",
  "time": "Time",
  "down": "Down",
  "up": "Up",
  "knee": "Knee",
  "hip": "Hip",
  "ankle": "Ankle",
  "depthM": "Depth m",
  "elbow": "Elbow",
  "shoulder": "Shldr",
  "riseM": "Rise m",
  "flightS": "Flight s",
  "heightFlight": "Height cm<br>flight time",
  "heightHipRise": "Height cm<br>hip rise",
  "countermove": "Counter-<br>move cm",
  "pushS": "Push s",
  "muscle": "Muscle",
  "rightPeakN": "Right, peak N",
  "leftPeakN": "Left, peak N",
  "joint": "Joint",
  "right": "Right",
  "left": "Left",
  "walking": "Walking",
  "running": "Running",
  "jointContactForce": "Joint contact force",
  "jointMoments": "Joint moments",
  "muscleAndJointForces": "Muscle and joint forces",
  "musclePctPeak": "Muscle force, % of each muscle's own peak",
  "downloadMot": "Download angles (.mot) + moments (.sto)",
  "downloadMotOnly": "Download angles (.mot)",
  "downloadZip": "Download everything (.zip)",
  "solidRightDottedLeft": "solid right · dotted left",
  "sdBetweenReps": "shaded: ±1 SD between reps",
  "gaitLevel": "gait literature, peak level",
  "setMean": "set mean",
  "whisker": "whisker: rep range within the set",
  // --- training ------------------------------------------------------------
  "trainingSession": "Training session",
  "sets": "sets",
  "startedAt": "started",
  "pastSessions": "past session(s) on this device",
  "finishSummarise": "Finish and summarise",
  "newSession": "Start a new session",
  "summary": "Summary",
  "measure": "Measure",
  "firstSet": "First set",
  "lastSet": "Last set",
  "change": "Change",
  "saveExport": "Save & export session (.zip)",
  "close": "Close",
  // --- status and warnings the user must act on ----------------------------
  "loadingEngine": "Loading pose engine (about 45 MB the first time)…",
  "ready": "Ready. Prop the phone up so your whole body is in frame.",
  "recording": "Recording…",
  "analysing": "Analysing…",
  "nameFirst": "Give the athlete a name first.",
  "savedTo": "Saved to “{name}”.",
  "profileDeleted": "Profile “{name}” deleted.",
  "sessionOnly": "These settings apply to this session. Give the athlete a name "
               + "and press Save profile to keep them.",
  "noRepsFound": "No {activity} found",
  "feetNotInFrame": "The feet were only in frame for {pct}% of the clip. A jump is "
                  + "measured entirely from the feet — when they leave the picture the "
                  + "pose model keeps reporting a position for them anyway, and that "
                  + "guess drifts, which reads as flight. Step back until your feet and "
                  + "head are both in frame, film side on, and try again.",
  "reshootSideOn": "Knee, hip and ankle angles are sagittal measurements and are only "
                 + "valid filmed from the side. Re-shoot side on.",
  "heightsDisagree": "The two heights disagree by more than a factor of two on "
                   + "{n} of {total}. Re-shoot with the whole body in frame and side on "
                   + "before believing either number.",
  "hadCountermovement": "{n} of {total} had a countermovement: the hip dipped before the "
                      + "push. A squat jump starts from a held squat and goes straight up, "
                      + "so those are countermovement jumps and will read higher.",
  "noCountermovement": "{n} of {total} had no countermovement: the hip did not dip before "
                     + "the push, so those are squat jumps and will read lower.",
  "checkMass": "check it",
  "today": "today",
  "daysAgo": "{n} d ago",
};

const PT = {
  "athlete": "Atleta",
  "noProfile": "— sem perfil —",
  "name": "Nome",
  "height": "Altura (m)",
  "dob": "Data de nascimento",
  "mass": "Massa (kg)",
  "years": "anos",
  "saveProfile": "Guardar perfil",
  "delete": "Eliminar",
  "exportData": "Exportar os meus dados",
  "import": "Importar",
  "language": "Idioma",
  "movement": "Movimento",
  "auto": "Detetar automaticamente",
  "pullup": "Elevação na barra",
  "squat": "Agachamento",
  "cmj": "Salto com contramovimento",
  "sj": "Salto sem contramovimento",
  "neck": "Pescoço (grande plano)",
  "addedLoad": "Carga adicional (kg)",
  "assistance": "Assistência (kg)",
  "overlay": "Esqueleto sobreposto",
  "overlayNone": "Nenhum — apenas os pontos",
  "headSize": "Tamanho da cabeça",
  "keepVideo": "Guardar também o vídeo na exportação",
  "startCamera": "Ligar a câmara",
  "analyseFile": "Analisar um ficheiro de vídeo",
  "startRecording": "Iniciar gravação",
  "stopRecording": "Parar gravação",
  "switchCamera": "Trocar de câmara",
  "closeCamera": "Desligar a câmara",
  "showing": "A mostrar",
  "set": "Série",
  "rep": "Rep",
  "jump": "Salto",
  "mean": "Média",
  "reps": "Reps",
  "load": "Carga",
  "time": "Hora",
  "down": "Descida",
  "up": "Subida",
  "knee": "Joelho",
  "hip": "Anca",
  "ankle": "Tornozelo",
  "depthM": "Profundidade m",
  "elbow": "Cotovelo",
  "shoulder": "Ombro",
  "riseM": "Subida m",
  "flightS": "Voo s",
  "heightFlight": "Altura cm<br>tempo de voo",
  "heightHipRise": "Altura cm<br>subida da anca",
  "countermove": "Contra-<br>movimento cm",
  "pushS": "Impulsão s",
  "muscle": "Músculo",
  "rightPeakN": "Direita, pico N",
  "leftPeakN": "Esquerda, pico N",
  "joint": "Articulação",
  "right": "Direita",
  "left": "Esquerda",
  "walking": "Marcha",
  "running": "Corrida",
  "jointContactForce": "Força de contacto articular",
  "jointMoments": "Momentos articulares",
  "muscleAndJointForces": "Forças musculares e articulares",
  "musclePctPeak": "Força muscular, % do pico de cada músculo",
  "downloadMot": "Descarregar ângulos (.mot) + momentos (.sto)",
  "downloadMotOnly": "Descarregar ângulos (.mot)",
  "downloadZip": "Descarregar tudo (.zip)",
  "solidRightDottedLeft": "contínuo direita · pontilhado esquerda",
  "sdBetweenReps": "sombreado: ±1 DP entre repetições",
  "gaitLevel": "literatura da marcha, valor de pico",
  "setMean": "média da série",
  "whisker": "barra: amplitude das repetições da série",
  "trainingSession": "Sessão de treino",
  "sets": "séries",
  "startedAt": "início",
  "pastSessions": "sessão(ões) anterior(es) neste dispositivo",
  "finishSummarise": "Terminar e resumir",
  "newSession": "Iniciar nova sessão",
  "summary": "Resumo",
  "measure": "Medida",
  "firstSet": "Primeira série",
  "lastSet": "Última série",
  "change": "Variação",
  "saveExport": "Guardar e exportar sessão (.zip)",
  "close": "Fechar",
  "loadingEngine": "A carregar o modelo de pose (cerca de 45 MB da primeira vez)…",
  "ready": "Pronto. Apoie o telemóvel de modo a ficar com o corpo todo no enquadramento.",
  "recording": "A gravar…",
  "analysing": "A analisar…",
  "nameFirst": "Dê primeiro um nome ao atleta.",
  "savedTo": "Guardado em “{name}”.",
  "profileDeleted": "Perfil “{name}” eliminado.",
  "sessionOnly": "Estas definições aplicam-se apenas a esta sessão. Dê um nome ao "
               + "atleta e carregue em Guardar perfil para as manter.",
  "noRepsFound": "Nenhum(a) {activity} encontrado(a)",
  "feetNotInFrame": "Os pés só estiveram no enquadramento em {pct}% do vídeo. Um salto é "
                  + "medido inteiramente a partir dos pés — quando saem da imagem o modelo "
                  + "continua a indicar uma posição para eles, e essa estimativa deriva, o "
                  + "que é lido como tempo de voo. Afaste-se até ter os pés e a cabeça no "
                  + "enquadramento, filme de perfil e tente de novo.",
  "reshootSideOn": "Os ângulos do joelho, anca e tornozelo são medidas sagitais e só são "
                 + "válidos filmados de perfil. Repita a filmagem de perfil.",
  "heightsDisagree": "As duas alturas diferem por mais do dobro em {n} de {total}. "
                   + "Repita a filmagem com o corpo todo no enquadramento e de perfil "
                   + "antes de acreditar em qualquer um dos valores.",
  "hadCountermovement": "{n} de {total} tiveram contramovimento: a anca desceu antes da "
                      + "impulsão. Um salto sem contramovimento parte de um agachamento "
                      + "mantido e sobe directamente, por isso esses são saltos com "
                      + "contramovimento e vão dar valores mais altos.",
  "noCountermovement": "{n} de {total} não tiveram contramovimento: a anca não desceu antes "
                     + "da impulsão, por isso esses são saltos sem contramovimento e vão dar "
                     + "valores mais baixos.",
  "checkMass": "verifique",
  "today": "hoje",
  "daysAgo": "há {n} d",
};

const DE = {
  "athlete": "Athlet",
  "noProfile": "— kein Profil —",
  "name": "Name",
  "height": "Größe (m)",
  "dob": "Geburtsdatum",
  "mass": "Masse (kg)",
  "years": "Jahre",
  "saveProfile": "Profil speichern",
  "delete": "Löschen",
  "exportData": "Meine Daten exportieren",
  "import": "Importieren",
  "language": "Sprache",
  "movement": "Bewegung",
  "auto": "Automatisch erkennen",
  "pullup": "Klimmzug",
  "squat": "Kniebeuge",
  "cmj": "Counter-Movement-Sprung",
  "sj": "Squat Jump",
  "neck": "Nacken (Nahaufnahme)",
  "addedLoad": "Zusatzlast (kg)",
  "assistance": "Entlastung (kg)",
  "overlay": "Skelett-Overlay",
  "overlayNone": "Keines — nur die Punkte",
  "headSize": "Kopfgröße",
  "keepVideo": "Video ebenfalls im Export behalten",
  "startCamera": "Kamera starten",
  "analyseFile": "Videodatei analysieren",
  "startRecording": "Aufnahme starten",
  "stopRecording": "Aufnahme beenden",
  "switchCamera": "Kamera wechseln",
  "closeCamera": "Kamera schließen",
  "showing": "Angezeigt",
  "set": "Satz",
  "rep": "Wdh.",
  "jump": "Sprung",
  "mean": "Mittel",
  "reps": "Wdh.",
  "load": "Last",
  "time": "Zeit",
  "down": "Ab",
  "up": "Auf",
  "knee": "Knie",
  "hip": "Hüfte",
  "ankle": "Sprunggelenk",
  "depthM": "Tiefe m",
  "elbow": "Ellbogen",
  "shoulder": "Schulter",
  "riseM": "Hub m",
  "flightS": "Flugzeit s",
  "heightFlight": "Höhe cm<br>Flugzeit",
  "heightHipRise": "Höhe cm<br>Hüfthub",
  "countermove": "Gegen-<br>bewegung cm",
  "pushS": "Abdruck s",
  "muscle": "Muskel",
  "rightPeakN": "Rechts, Spitze N",
  "leftPeakN": "Links, Spitze N",
  "joint": "Gelenk",
  "right": "Rechts",
  "left": "Links",
  "walking": "Gehen",
  "running": "Laufen",
  "jointContactForce": "Gelenkkontaktkraft",
  "jointMoments": "Gelenkmomente",
  "muscleAndJointForces": "Muskel- und Gelenkkräfte",
  "musclePctPeak": "Muskelkraft, % des eigenen Maximums",
  "downloadMot": "Winkel (.mot) + Momente (.sto) herunterladen",
  "downloadMotOnly": "Winkel (.mot) herunterladen",
  "downloadZip": "Alles herunterladen (.zip)",
  "solidRightDottedLeft": "durchgezogen rechts · gepunktet links",
  "sdBetweenReps": "schattiert: ±1 SD zwischen den Wiederholungen",
  "gaitLevel": "Gangliteratur, Spitzenwert",
  "setMean": "Satzmittel",
  "whisker": "Balken: Spannweite der Wiederholungen im Satz",
  "trainingSession": "Trainingseinheit",
  "sets": "Sätze",
  "startedAt": "begonnen",
  "pastSessions": "frühere Einheit(en) auf diesem Gerät",
  "finishSummarise": "Beenden und zusammenfassen",
  "newSession": "Neue Einheit starten",
  "summary": "Zusammenfassung",
  "measure": "Messgröße",
  "firstSet": "Erster Satz",
  "lastSet": "Letzter Satz",
  "change": "Änderung",
  "saveExport": "Einheit speichern & exportieren (.zip)",
  "close": "Schließen",
  "loadingEngine": "Pose-Modell wird geladen (beim ersten Mal etwa 45 MB)…",
  "ready": "Bereit. Stellen Sie das Telefon so auf, dass der ganze Körper im Bild ist.",
  "recording": "Aufnahme läuft…",
  "analysing": "Wird ausgewertet…",
  "nameFirst": "Geben Sie dem Athleten zuerst einen Namen.",
  "savedTo": "In „{name}“ gespeichert.",
  "profileDeleted": "Profil „{name}“ gelöscht.",
  "sessionOnly": "Diese Einstellungen gelten nur für diese Sitzung. Geben Sie dem "
               + "Athleten einen Namen und drücken Sie Profil speichern, um sie zu behalten.",
  "noRepsFound": "Keine {activity} gefunden",
  "feetNotInFrame": "Die Füße waren nur in {pct}% des Clips im Bild. Ein Sprung wird "
                  + "vollständig über die Füße gemessen — verlassen sie das Bild, meldet "
                  + "das Pose-Modell trotzdem eine Position für sie, und diese Schätzung "
                  + "driftet, was als Flugphase gelesen wird. Treten Sie zurück, bis Füße "
                  + "und Kopf im Bild sind, filmen Sie von der Seite und versuchen Sie es erneut.",
  "reshootSideOn": "Knie-, Hüft- und Sprunggelenkwinkel sind sagittale Messungen und nur "
                 + "gültig, wenn von der Seite gefilmt wird. Bitte seitlich neu aufnehmen.",
  "heightsDisagree": "Die beiden Höhen weichen bei {n} von {total} um mehr als das Doppelte "
                   + "voneinander ab. Nehmen Sie mit dem ganzen Körper im Bild und von der "
                   + "Seite neu auf, bevor Sie einem der Werte glauben.",
  "hadCountermovement": "{n} von {total} hatten eine Gegenbewegung: die Hüfte senkte sich vor "
                      + "dem Abdruck. Ein Squat Jump beginnt aus der gehaltenen Kniebeuge und "
                      + "geht direkt nach oben, also sind das Counter-Movement-Sprünge und sie "
                      + "fallen höher aus.",
  "noCountermovement": "{n} von {total} hatten keine Gegenbewegung: die Hüfte senkte sich vor "
                     + "dem Abdruck nicht, also sind das Squat Jumps und sie fallen niedriger aus.",
  "checkMass": "prüfen",
  "today": "heute",
  "daysAgo": "vor {n} T",
};

const DICTS = { en: EN, pt: PT, de: DE };

function stored() {
  try { return localStorage.getItem(LKEY); } catch { return null; }
}

/** Browser language, but only if there is a translation for it. */
function fromBrowser() {
  const tags = (typeof navigator !== "undefined" && navigator.languages)
    || [typeof navigator !== "undefined" ? navigator.language : "en"];
  for (const tag of tags) {
    const base = String(tag || "").toLowerCase().split("-")[0];
    if (DICTS[base]) return base;
  }
  return "en";
}

let lang = (stored() && DICTS[stored()]) ? stored() : fromBrowser();

export function getLang() { return lang; }

export function setLang(next) {
  if (!DICTS[next]) return false;
  lang = next;
  try { localStorage.setItem(LKEY, next); } catch { /* private window */ }
  return true;
}

/**
 * Translate. Unknown keys fall back to English and then to the key itself, so
 * an incomplete translation shows English rather than a raw identifier.
 * `vars` fills {placeholders}.
 */
export function t(key, vars) {
  let s = DICTS[lang][key];
  if (s === undefined) s = EN[key];
  if (s === undefined) return key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

/** Keys English has that a translation does not: an honest to-do list. */
export function missingKeys(which) {
  const d = DICTS[which] || {};
  return Object.keys(EN).filter((k) => d[k] === undefined);
}

/** Keys a translation has that English no longer does: dead weight, and the
 *  sign that a wording changed on one side only. */
export function staleKeys(which) {
  const d = DICTS[which] || {};
  return Object.keys(d).filter((k) => EN[k] === undefined);
}

export const ALL_LANGS = Object.keys(DICTS);
