/**
 * sports.js -- which sport a training session is, and which movements it
 * offers.
 *
 * A session is picked by sport before it starts, and the recorder's Movement
 * list then shows that sport's movements only: a basketball session does not
 * need the pull-up and the dip in the way of the jump shot. "Detect
 * automatically" stays in both lists.
 *
 * The lists are the movements the app can already analyse, grouped by where
 * they are trained. A movement can sit in more than one sport -- jumps are
 * strength work and basketball work alike. Sessions from before sports existed
 * have none, and show every movement.
 */
export const SPORTS = {
  strength: ["squat", "slsquat", "pullup", "dip", "kickback", "heelraise", "cmj", "sj", "neck"],
  basketball: ["jumpshot", "cmj", "sj", "sidestep", "run", "walk"],
};

export const SPORT_IDS = Object.keys(SPORTS);

/** The movements a session of `sport` offers, or null for "all of them". */
export function sportActivities(sport) {
  return SPORTS[sport] ? SPORTS[sport].slice() : null;
}

/** Whether `activity` belongs in a session of `sport` ("auto" always does). */
export function allowedIn(sport, activity) {
  if (activity === "auto") return true;
  const list = SPORTS[sport];
  return !list || list.includes(activity);
}
