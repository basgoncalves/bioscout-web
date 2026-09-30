/**
 * loaddir.js -- which way the added load acts.
 *
 * "Added load" used to mean one thing: mass hung on the athlete (a bar, a
 * vest, a belt) that gravity pulls straight down. Every consumer assumed it --
 * inverse dynamics adds it to the system weight, the energy model lifts it,
 * the training-intensity chart divides it by body mass.
 *
 * A neck strength test is not that (Bas, 2026-09-30: max isometric lateral
 * flexion, a strap round the head pulled sideways by a cable). The same "10 kg"
 * is now a horizontal force on the head, and adding it to the body weight
 * would put 10 kg on the knees of a man sitting in a car seat. So the
 * direction is recorded with the load, and anything that treats the load as
 * weight asks `verticalKg` instead of reading `addedKg`.
 *
 * Directions are named for the way the ATHLETE PUSHES against the load -- that
 * is how a test is described ("pushing to his left") and it survives a
 * mirrored selfie camera, which "towards the cable" does not. The force the
 * load puts on the athlete is the opposite way.
 *
 * Pure, no DOM: the recorder, the summaries and the tests share it.
 */

export const G = 9.80665;

/** In the order the picker shows them. "down" is the old meaning and the
 *  default; a set stored before this file existed has no loadDir and is down. */
export const LOAD_DIRS = ["down", "left", "right", "forward", "back"];

export function normLoadDir(d) {
  return LOAD_DIRS.includes(d) ? d : "down";
}

export function isHorizontal(d) {
  return normLoadDir(d) !== "down";
}

/** The part of the added load that is weight: all of it hanging, none of it
 *  pulled sideways. Assistance is not touched -- a band or a machine offload
 *  still acts along gravity. */
export function verticalKg(set) {
  if (!set) return 0;
  return isHorizontal(set.loadDir) ? 0 : (Number(set.addedKg) || 0);
}

/** Net vertical external load in kg (added minus assistance), the quantity
 *  inverse dynamics and the system weight use. */
export function netVerticalKg(set) {
  return verticalKg(set) - (Number(set && set.assistKg) || 0);
}

/**
 * "+10 kg", or "+10 kg · push left" for a horizontal load. `tr` supplies the
 * words (keys loadDirShort_<dir>); without it the direction id is used.
 */
export function loadText(set, tr) {
  const kg = Number(set && set.addedKg) || 0;
  if (!kg) return "";
  const d = normLoadDir(set.loadDir);
  if (d === "down") return `+${kg} kg`;
  const word = tr ? tr("loadDirShort_" + d) : d;
  return `+${kg} kg · ${word}`;
}

/* Head mass as a share of body mass: de Leva (1996), adjusted Zatsiorsky-
 * Seluyanov segment parameters, head and neck together -- 6.94 % in men and
 * 6.68 % in women. It is the mass a lateral acceleration acts on in a car, so
 * it is what turns a horizontal pull on the head into "the same force as N g". */
const HEAD_FRAC = { male: 0.0694, female: 0.0668 };

export function headMassKg(massKg, sex) {
  const m = Number(massKg);
  if (!(m > 0)) return null;
  return m * (HEAD_FRAC[sex] ?? (HEAD_FRAC.male + HEAD_FRAC.female) / 2);
}

/**
 * A horizontal load on the head, in the units a neck test is read in.
 *
 *   forceN -- the load in newtons (kg x g). The scale reads kilograms of force;
 *             this is the same number in the unit the g-load reference uses.
 *   gEquiv -- the sideways acceleration that would put the same force on the
 *             head by itself: forceN / (head mass x g). Only as good as the
 *             assumption that the strap pulls at the head's centre of mass; a
 *             strap above it makes a bigger neck moment for the same force.
 *
 * Null when the load is not horizontal or there is none.
 */
export function neckPush(set, { massKg, sex } = {}) {
  if (!set || !isHorizontal(set.loadDir)) return null;
  const kg = Number(set.addedKg) || 0;
  if (!(kg > 0)) return null;
  const forceN = kg * G;
  const head = headMassKg(massKg ?? set.massKg, sex);
  return {
    dir: normLoadDir(set.loadDir),
    kg,
    forceN,
    headKg: head,
    gEquiv: head ? kg / head : null,
  };
}
