/**
 * protocol.js -- sessions that run to a fixed script.
 *
 * Two of them, both timed, both counted by the camera:
 *
 *   tomholland  the round Tom Holland is said to have done 28 times in 20
 *               minutes: 5 pull-ups, 10 push-ups, 15 squats, again and again
 *               until the clock runs out. The app counts the rounds; 28 is
 *               shown as the mark to chase, not as a target the athlete has
 *               to reach.
 *   tabata      8 rounds of 20 seconds of work and 10 seconds of rest, on one
 *               movement the athlete picks. Four minutes, eight sets.
 *
 * Everything here is arithmetic on what has been recorded so far -- which step
 * is next, how many rounds are done, how much time is left. The recorder
 * (index.html) owns the camera, the beeps and the clock; it asks this module
 * what to do next so that the rules live in one place and can be tested
 * without a camera.
 */

export const TH_STEPS = [
  { activity: "pullup", reps: 5 },
  { activity: "pushup", reps: 10 },
  { activity: "squat", reps: 15 },
];

export const PROTOCOLS = {
  tomholland: { id: "tomholland", totalS: 20 * 60, steps: TH_STEPS, record: 28, pickActivity: false },
  tabata: { id: "tabata", rounds: 8, workS: 20, restS: 10, pickActivity: true,
            get totalS() { return this.rounds * (this.workS + this.restS) - this.restS; } },
};

export const isProtocol = (sport) => Object.prototype.hasOwnProperty.call(PROTOCOLS, sport);

/** Movements a Tabata round may be done with: the ones the app counts reps
 *  of. Jumps and gait are counted too but a 20-second set of walking is not
 *  Tabata, so the list is the rep-for-rep movements. */
export const TABATA_ACTIVITIES = ["squat", "pushup", "pullup", "dip", "heelraise",
                                  "kickback", "slsquat", "cmj", "sj"];

/**
 * Where the circuit is after `done` completed steps: which round (from 1),
 * which step inside it, and how many rounds are finished.
 */
export function circuitAt(done, steps = TH_STEPS) {
  const n = Math.max(0, Math.floor(done));
  const per = steps.length;
  return { round: Math.floor(n / per) + 1, stepIndex: n % per,
           roundsDone: Math.floor(n / per), step: steps[n % per] };
}

/** Seconds left of a protocol that started at `startedAt` (ms). */
export function timeLeft(kind, startedAt, now) {
  const p = PROTOCOLS[kind];
  if (!p || startedAt == null) return null;
  return Math.max(0, p.totalS - (now - startedAt) / 1000);
}

/** "20:00", "4:05", "0:09". */
export function fmtTime(s) {
  const v = Math.max(0, Math.ceil(s - 1e-9));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

/**
 * What the recorder should do when a step has just been recorded.
 * `done` counts the steps finished INCLUDING the one just recorded.
 *
 * Returns {do: "next"|"done", ...}: "next" carries the movement and target
 * for the coming step (and, for Tabata, how long to rest first); "done" ends
 * the session. A protocol stops on its own clock -- the round in progress is
 * always finished, never cut off mid-set.
 */
export function afterStep(kind, { done, startedAt, now, activity = null }) {
  const p = PROTOCOLS[kind];
  if (!p) return { do: "done" };
  if (kind === "tabata") {
    if (done >= p.rounds) return { do: "done", rounds: done, activity };
    return { do: "next", activity, round: done + 1, rounds: p.rounds,
             restS: p.restS, workS: p.workS, reps: null };
  }
  const left = timeLeft(kind, startedAt, now);
  const at = circuitAt(done, p.steps);
  // Out of time: the round on the clock is over at the end of the step that
  // was running, not part way through the next one.
  if (left <= 0) return { do: "done", rounds: at.roundsDone, partial: at.stepIndex };
  return { do: "next", activity: at.step.activity, reps: at.step.reps,
           round: at.round, stepIndex: at.stepIndex, roundsDone: at.roundsDone, leftS: left };
}

/**
 * The session's sets, as the protocol reads them. Sets are counted in the
 * order they were recorded -- that IS the circuit.
 */
export function protocolSummary(kind, sets = []) {
  const p = PROTOCOLS[kind];
  const list = sets.filter((s) => s && s.activity);
  if (kind === "tomholland") {
    const at = circuitAt(list.length, p.steps);
    const reps = list.reduce((a, b) => a + (b.reps || 0), 0);
    return { kind, rounds: at.roundsDone, partialSteps: at.stepIndex, reps,
             record: p.record, sets: list.length };
  }
  if (kind === "tabata") {
    const activity = list.length ? list[list.length - 1].activity : null;
    const reps = list.map((s) => s.reps || 0);
    return { kind, activity, rounds: list.length, target: p.rounds, reps,
             total: reps.reduce((a, b) => a + b, 0),
             best: reps.length ? Math.max(...reps) : 0,
             worst: reps.length ? Math.min(...reps) : 0 };
  }
  return null;
}
