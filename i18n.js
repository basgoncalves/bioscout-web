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
  // --- movements added 3 Sep --------------------------------------------
  "slsquat": "Single-leg squat",
  "run": "Running",
  "sidestep": "Side step",
  // --- results tables ------------------------------------------------------
  "left": "Left",
  "right": "Right",
  "leftShort": "L",
  "rightShort": "R",
  "refShort": "ref",
  "stance": "Stance leg",
  "stanceKnee": "Stance knee",
  "lrDiff": "L\u2013R difference",
  "stride": "Stride",
  "strideS": "Stride s",
  "contactS": "Contact s",
  "dutyFactor": "Duty factor",
  "cadence": "Steps/min",
  "step": "Step",
  "plantSide": "Plant",
  "outS": "Out s",
  "backS": "Back s",
  "excursionM": "Sideways m",
  "kneeAtPlant": "Knee at plant",
  "repN": "Rep {n}",
  "meanOfN": "Mean ({n})",
  // --- chart series --------------------------------------------------------
  "kneeFlexion": "knee flexion",
  "hipFlexion": "hip flexion",
  "ankleDorsi": "ankle dorsiflexion",
  "elbowFlexion": "elbow flexion",
  "shoulderFlexion": "shoulder flexion",
  "hipJoint": "Hip",
  "kneeJoint": "Knee",
  "ankleJoint": "Ankle",
  "netMomentOf": "{joint} moment (net)",
  "peakWord": "peak",
  "extensionPositive": "Extension positive",
  "perLegLabel": "per leg",
  "peakGrfLabel": "peak GRF",
  "timesSystemWeight": "\u00d7 system weight",
  "isolatedMuscle": "Isolated: {name}. Tap it again to show all {n}.",
  "contribHint": "Coloured curves are each muscle's contribution \u2014 force \u00d7 moment arm. Tap one to isolate it.",
  "needMomentArms": "Muscle contributions need moment arms from the .osim model: run tools/moment_arms.py to add moment_arms.json and they appear on this plot.",
  // --- camera view ---------------------------------------------------------
  "view_frontal": "frontal",
  "view_oblique": "oblique",
  "view_sagittal": "sagittal",
  "viewNotSagittal": "This looks like a <b>{view}</b> view (frontality {frontality}). Knee, hip and ankle angles are sagittal measurements and are only valid filmed from the side. Re-shoot side on.",
  "viewJumpHeight": "Filmed <b>{view}</b>. Flight time survives that, but the hip-rise height does not: it measures vertical travel in the image, and off the sagittal plane the hip moves toward or away from the camera as well. If the two heights disagree, this is the first thing to fix.",
  "ankleNotMeasurable": "Ankle angle could not be measured \u2014 the foot is pointing at or away from the camera, which flattens the knee-ankle-toe angle. It is written as 0 in the .mot rather than a fabricated value.",
  "runNoKinetics": "No moments or muscle forces are shown for running. The athlete travels across the frame, so the pixel-to-metre scale changes with distance from the camera, and the ground reaction is derived from that scale. Angles and stride timing are unaffected.",
  "sidestepNoKinetics": "No moments or muscle forces are shown for a side step. The movement is mostly out of the plane a single camera measures, so any joint moment computed from it would be a confident-looking number about the wrong plane.",
  "looksLikeWalking": "{n} of {total} strides had at least one foot on the floor at all times (duty factor at or above 0.5). That is walking, not running \u2014 the timings are still correct, the label is not.",
  "bothFeetDown": "Both feet were on the floor for most of the clip, so no stance leg could be identified. This was recorded as a single-leg squat but does not look like one.",
  // --- detection -----------------------------------------------------------
  "detectedAs": "Detected <b>{activity}</b> ({conf} confidence, margin {margin})",
  "detectedAuto": "Detected automatically",
  "whyStill": "Nothing moved: no joint changed by more than a few degrees and the body did not translate. Record during the movement.",
  "whyNoMatch": "Nothing matched: the strongest was {best} at {conf}, below the {min} threshold.",
  "why_pullup": "hands overhead {pct}% of the time, body rose {rise} torso lengths, elbow range {elbow}\u00b0",
  "why_squat": "feet stayed planted, knee range {knee}\u00b0, hip range {hip}\u00b0, hips dropped {drop} torso lengths",
  "why_neck": "head fills {pct}% of a torso length, nose moved {nose} head widths, trunk barely moved",
  "why_cmj": "feet off the floor and hips above standing for {pct}% of the clip, hips dipped {cmv} torso lengths before take-off, knee range {knee}\u00b0",
  "why_sj": "feet off the floor and hips above standing for {pct}% of the clip with no dip before take-off ({cmv} torso lengths), knee range {knee}\u00b0",
  "why_slsquat": "one foot raised for {pct}% of the clip with the other planted, the two knees differing by {asym}\u00b0, knee range {knee}\u00b0",
  "why_run": "{bouts} separate flight phases with one foot down between them ({alt}% single support), knee range {knee}\u00b0",
  "why_sidestep": "hips travelled {lat} torso lengths sideways and the feet moved {feet}, with no flight phase",
  "trackedWord": "tracked",
  "viewLabel": "{view} view",
  "motSignedFor": ".mot signed for {model}",
  "view_unknown": "unknown",
  "tagline": "Movement analysis in the browser. Video never leaves your phone.",
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
  // --- movimentos adicionados a 3 Set -------------------------------------
  "slsquat": "Agachamento unipodal",
  "run": "Corrida",
  "sidestep": "Mudan\u00e7a de dire\u00e7\u00e3o lateral",
  // --- tabelas de resultados ----------------------------------------------
  "left": "Esquerda",
  "right": "Direita",
  "leftShort": "E",
  "rightShort": "D",
  "refShort": "ref",
  "stance": "Perna de apoio",
  "stanceKnee": "Joelho de apoio",
  "lrDiff": "Diferen\u00e7a E\u2013D",
  "stride": "Passada",
  "strideS": "Passada s",
  "contactS": "Contacto s",
  "dutyFactor": "Fator de apoio",
  "cadence": "Passos/min",
  "step": "Passo",
  "plantSide": "Apoio",
  "outS": "Ida s",
  "backS": "Volta s",
  "excursionM": "Lateral m",
  "kneeAtPlant": "Joelho no apoio",
  "repN": "Rep {n}",
  "meanOfN": "M\u00e9dia ({n})",
  // --- s\u00e9ries dos gr\u00e1ficos --------------------------------------
  "kneeFlexion": "flex\u00e3o do joelho",
  "hipFlexion": "flex\u00e3o da anca",
  "ankleDorsi": "dorsiflex\u00e3o do tornozelo",
  "elbowFlexion": "flex\u00e3o do cotovelo",
  "shoulderFlexion": "flex\u00e3o do ombro",
  "hipJoint": "Anca",
  "kneeJoint": "Joelho",
  "ankleJoint": "Tornozelo",
  "netMomentOf": "Momento: {joint} (l\u00edquido)",
  "peakWord": "pico",
  "extensionPositive": "Extens\u00e3o positiva",
  "perLegLabel": "por perna",
  "peakGrfLabel": "pico da for\u00e7a de rea\u00e7\u00e3o",
  "timesSystemWeight": "\u00d7 peso do sistema",
  "isolatedMuscle": "Isolado: {name}. Toque outra vez para mostrar os {n}.",
  "contribHint": "As curvas coloridas s\u00e3o a contribui\u00e7\u00e3o de cada m\u00fasculo \u2014 for\u00e7a \u00d7 bra\u00e7o de momento. Toque numa para a isolar.",
  "needMomentArms": "As contribui\u00e7\u00f5es musculares precisam dos bra\u00e7os de momento do modelo .osim: corra tools/moment_arms.py para criar moment_arms.json e aparecem neste gr\u00e1fico.",
  // --- vista da c\u00e2mara -------------------------------------------------
  "view_frontal": "frontal",
  "view_oblique": "obl\u00edqua",
  "view_sagittal": "sagital",
  "viewNotSagittal": "Isto parece uma vista <b>{view}</b> (frontalidade {frontality}). Os \u00e2ngulos do joelho, anca e tornozelo s\u00e3o medidas sagitais e s\u00f3 s\u00e3o v\u00e1lidos filmados de perfil. Repita a filmagem de perfil.",
  "viewJumpHeight": "Filmado em vista <b>{view}</b>. O tempo de voo sobrevive a isso, a altura pela subida da anca n\u00e3o: mede o deslocamento vertical na imagem, e fora do plano sagital a anca tamb\u00e9m se aproxima ou afasta da c\u00e2mara. Se as duas alturas divergirem, \u00e9 isto que h\u00e1 a corrigir primeiro.",
  "ankleNotMeasurable": "N\u00e3o foi poss\u00edvel medir o \u00e2ngulo do tornozelo \u2014 o p\u00e9 aponta para a c\u00e2mara ou para o lado oposto, o que achata o \u00e2ngulo joelho-tornozelo-dedos. Fica escrito como 0 no .mot em vez de um valor inventado.",
  "runNoKinetics": "N\u00e3o s\u00e3o mostrados momentos nem for\u00e7as musculares para a corrida. O atleta desloca-se pelo enquadramento, por isso a escala p\u00edxel-metro muda com a dist\u00e2ncia \u00e0 c\u00e2mara, e a for\u00e7a de rea\u00e7\u00e3o \u00e9 derivada dessa escala. Os \u00e2ngulos e os tempos de passada n\u00e3o s\u00e3o afetados.",
  "sidestepNoKinetics": "N\u00e3o s\u00e3o mostrados momentos nem for\u00e7as musculares para a mudan\u00e7a de dire\u00e7\u00e3o. O movimento est\u00e1 sobretudo fora do plano que uma \u00fanica c\u00e2mara mede, por isso qualquer momento articular calculado a partir dele seria um n\u00famero convincente sobre o plano errado.",
  "looksLikeWalking": "{n} de {total} passadas tiveram sempre pelo menos um p\u00e9 no ch\u00e3o (fator de apoio igual ou superior a 0,5). Isso \u00e9 marcha, n\u00e3o corrida \u2014 os tempos continuam corretos, a designa\u00e7\u00e3o n\u00e3o.",
  "bothFeetDown": "Os dois p\u00e9s estiveram no ch\u00e3o durante a maior parte do v\u00eddeo, por isso n\u00e3o foi poss\u00edvel identificar a perna de apoio. Isto foi gravado como agachamento unipodal mas n\u00e3o parece s\u00ea-lo.",
  // --- dete\u00e7\u00e3o -----------------------------------------------------
  "detectedAs": "Detetado <b>{activity}</b> (confian\u00e7a {conf}, margem {margin})",
  "detectedAuto": "Detetado automaticamente",
  "whyStill": "Nada se mexeu: nenhuma articula\u00e7\u00e3o variou mais do que alguns graus e o corpo n\u00e3o se deslocou. Grave durante o movimento.",
  "whyNoMatch": "Nada correspondeu: o mais forte foi {best} com {conf}, abaixo do limiar de {min}.",
  "why_pullup": "m\u00e3os acima da cabe\u00e7a {pct}% do tempo, o corpo subiu {rise} comprimentos de tronco, amplitude do cotovelo {elbow}\u00b0",
  "why_squat": "os p\u00e9s mantiveram-se fixos, amplitude do joelho {knee}\u00b0, amplitude da anca {hip}\u00b0, a anca desceu {drop} comprimentos de tronco",
  "why_neck": "a cabe\u00e7a ocupa {pct}% de um comprimento de tronco, o nariz percorreu {nose} larguras de cabe\u00e7a, o tronco quase n\u00e3o se mexeu",
  "why_cmj": "p\u00e9s fora do ch\u00e3o e anca acima da posi\u00e7\u00e3o de p\u00e9 em {pct}% do v\u00eddeo, a anca desceu {cmv} comprimentos de tronco antes da impuls\u00e3o, amplitude do joelho {knee}\u00b0",
  "why_sj": "p\u00e9s fora do ch\u00e3o e anca acima da posi\u00e7\u00e3o de p\u00e9 em {pct}% do v\u00eddeo sem descida antes da impuls\u00e3o ({cmv} comprimentos de tronco), amplitude do joelho {knee}\u00b0",
  "why_slsquat": "um p\u00e9 levantado em {pct}% do v\u00eddeo com o outro apoiado, os dois joelhos a diferir {asym}\u00b0, amplitude do joelho {knee}\u00b0",
  "why_run": "{bouts} fases de voo separadas com um p\u00e9 no ch\u00e3o entre elas ({alt}% de apoio unipodal), amplitude do joelho {knee}\u00b0",
  "why_sidestep": "a anca deslocou-se {lat} comprimentos de tronco para o lado e os p\u00e9s moveram-se {feet}, sem qualquer fase de voo",
  "trackedWord": "seguido",
  "viewLabel": "vista {view}",
  "motSignedFor": ".mot com os sinais de {model}",
  "view_unknown": "desconhecida",
  "tagline": "An\u00e1lise do movimento no navegador. O v\u00eddeo nunca sai do seu telem\u00f3vel.",
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
  // --- am 3. September erg\u00e4nzte Bewegungen ----------------------------
  "slsquat": "Einbeinige Kniebeuge",
  "run": "Laufen",
  "sidestep": "Seitlicher Richtungswechsel",
  // --- Ergebnistabellen ----------------------------------------------------
  "left": "Links",
  "right": "Rechts",
  "leftShort": "L",
  "rightShort": "R",
  "refShort": "Ref.",
  "stance": "Standbein",
  "stanceKnee": "Standbein-Knie",
  "lrDiff": "Unterschied L\u2013R",
  "stride": "Doppelschritt",
  "strideS": "Doppelschritt s",
  "contactS": "Bodenkontakt s",
  "dutyFactor": "Kontaktanteil",
  "cadence": "Schritte/min",
  "step": "Schritt",
  "plantSide": "Aufsatz",
  "outS": "Hin s",
  "backS": "Zur\u00fcck s",
  "excursionM": "Seitlich m",
  "kneeAtPlant": "Knie beim Aufsatz",
  "repN": "Wdh. {n}",
  "meanOfN": "Mittel ({n})",
  // --- Diagrammkurven ------------------------------------------------------
  "kneeFlexion": "Knieflexion",
  "hipFlexion": "H\u00fcftflexion",
  "ankleDorsi": "Dorsalextension im Sprunggelenk",
  "elbowFlexion": "Ellbogenflexion",
  "shoulderFlexion": "Schulterflexion",
  "hipJoint": "H\u00fcfte",
  "kneeJoint": "Knie",
  "ankleJoint": "Sprunggelenk",
  "netMomentOf": "Moment: {joint} (netto)",
  "peakWord": "Maximum",
  "extensionPositive": "Extension positiv",
  "perLegLabel": "pro Bein",
  "peakGrfLabel": "max. Bodenreaktionskraft",
  "timesSystemWeight": "\u00d7 Systemgewicht",
  "isolatedMuscle": "Isoliert: {name}. Nochmals tippen, um alle {n} zu zeigen.",
  "contribHint": "Die farbigen Kurven sind der Beitrag jedes Muskels \u2014 Kraft \u00d7 Hebelarm. Tippen Sie eine an, um sie zu isolieren.",
  "needMomentArms": "Muskelbeitr\u00e4ge brauchen die Hebelarme aus dem .osim-Modell: f\u00fchren Sie tools/moment_arms.py aus, um moment_arms.json zu erzeugen \u2014 dann erscheinen sie in diesem Diagramm.",
  // --- Kameraperspektive ---------------------------------------------------
  "view_frontal": "frontale",
  "view_oblique": "schr\u00e4ge",
  "view_sagittal": "seitliche",
  "viewNotSagittal": "Das sieht nach einer <b>{view}</b> Ansicht aus (Frontalit\u00e4t {frontality}). Knie-, H\u00fcft- und Sprunggelenkwinkel sind sagittale Messungen und nur g\u00fcltig, wenn von der Seite gefilmt wird. Bitte seitlich neu aufnehmen.",
  "viewJumpHeight": "In <b>{view}</b> Ansicht gefilmt. Die Flugzeit \u00fcbersteht das, die H\u00f6he aus dem H\u00fcftanstieg nicht: sie misst die vertikale Bewegung im Bild, und au\u00dferhalb der Sagittalebene bewegt sich die H\u00fcfte auch auf die Kamera zu oder von ihr weg. Weichen die beiden H\u00f6hen voneinander ab, ist das zuerst zu beheben.",
  "ankleNotMeasurable": "Der Sprunggelenkwinkel konnte nicht gemessen werden \u2014 der Fu\u00df zeigt zur Kamera oder von ihr weg, was den Knie-Kn\u00f6chel-Zehen-Winkel abflacht. Er wird in der .mot als 0 geschrieben statt als erfundener Wert.",
  "runNoKinetics": "F\u00fcr das Laufen werden keine Momente und keine Muskelkr\u00e4fte gezeigt. Der Athlet bewegt sich durch das Bild, dadurch \u00e4ndert sich der Pixel-Meter-Ma\u00dfstab mit dem Abstand zur Kamera \u2014 und die Bodenreaktionskraft wird aus diesem Ma\u00dfstab abgeleitet. Winkel und Schrittzeiten sind davon nicht betroffen.",
  "sidestepNoKinetics": "F\u00fcr den seitlichen Richtungswechsel werden keine Momente und keine Muskelkr\u00e4fte gezeigt. Die Bewegung liegt gr\u00f6\u00dftenteils au\u00dferhalb der Ebene, die eine einzelne Kamera misst; jedes daraus berechnete Gelenkmoment w\u00e4re eine \u00fcberzeugend aussehende Zahl \u00fcber die falsche Ebene.",
  "looksLikeWalking": "Bei {n} von {total} Doppelschritten war durchgehend mindestens ein Fu\u00df am Boden (Kontaktanteil ab 0,5). Das ist Gehen, nicht Laufen \u2014 die Zeiten stimmen weiterhin, die Bezeichnung nicht.",
  "bothFeetDown": "Beide F\u00fc\u00dfe waren den gr\u00f6\u00dften Teil des Clips am Boden, deshalb konnte kein Standbein bestimmt werden. Dies wurde als einbeinige Kniebeuge aufgezeichnet, sieht aber nicht danach aus.",
  // --- Erkennung -----------------------------------------------------------
  "detectedAs": "Erkannt: <b>{activity}</b> (Konfidenz {conf}, Abstand {margin})",
  "detectedAuto": "Automatisch erkannt",
  "whyStill": "Nichts hat sich bewegt: kein Gelenk hat sich um mehr als ein paar Grad ver\u00e4ndert und der K\u00f6rper hat sich nicht verschoben. Nehmen Sie w\u00e4hrend der Bewegung auf.",
  "whyNoMatch": "Nichts passte: am st\u00e4rksten war {best} mit {conf}, unter der Schwelle von {min}.",
  "why_pullup": "H\u00e4nde {pct}% der Zeit \u00fcber dem Kopf, der K\u00f6rper stieg um {rise} Rumpfl\u00e4ngen, Ellbogenbereich {elbow}\u00b0",
  "why_squat": "die F\u00fc\u00dfe blieben am Boden, Kniebereich {knee}\u00b0, H\u00fcftbereich {hip}\u00b0, die H\u00fcfte sank um {drop} Rumpfl\u00e4ngen",
  "why_neck": "der Kopf f\u00fcllt {pct}% einer Rumpfl\u00e4nge, die Nase bewegte sich {nose} Kopfbreiten, der Rumpf kaum",
  "why_cmj": "F\u00fc\u00dfe vom Boden und H\u00fcfte \u00fcber Standh\u00f6he in {pct}% des Clips, die H\u00fcfte sank {cmv} Rumpfl\u00e4ngen vor dem Absprung, Kniebereich {knee}\u00b0",
  "why_sj": "F\u00fc\u00dfe vom Boden und H\u00fcfte \u00fcber Standh\u00f6he in {pct}% des Clips, ohne Absenken vor dem Absprung ({cmv} Rumpfl\u00e4ngen), Kniebereich {knee}\u00b0",
  "why_slsquat": "ein Fu\u00df in {pct}% des Clips angehoben, der andere am Boden, die beiden Knie unterscheiden sich um {asym}\u00b0, Kniebereich {knee}\u00b0",
  "why_run": "{bouts} getrennte Flugphasen mit je einem Fu\u00df am Boden dazwischen ({alt}% Einbeinstand), Kniebereich {knee}\u00b0",
  "why_sidestep": "die H\u00fcfte bewegte sich {lat} Rumpfl\u00e4ngen zur Seite und die F\u00fc\u00dfe {feet}, ohne jede Flugphase",
  "trackedWord": "erfasst",
  "viewLabel": "{view} Ansicht",
  "motSignedFor": ".mot mit den Vorzeichen von {model}",
  "view_unknown": "unbekannte",
  "tagline": "Bewegungsanalyse im Browser. Das Video verl\u00e4sst Ihr Ger\u00e4t nicht.",
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
