/**
 * neck_gload.js -- the 1-6 g neck-loading reference, or the absence of it.
 *
 * THIS FILE SHIPS EMPTY ON PURPOSE.
 *
 * The numbers that belong here -- peak roll moments, per-muscle forces and
 * saturation counts at 1-6 g of lateral load -- come from N. Berger's BSc
 * thesis simulations, which are UNPUBLISHED. They are his to publish first,
 * not this project's, and a public GitHub Pages site is publication: anything
 * the browser can fetch is downloadable by anyone who opens the page. So they
 * live in _private/neck_gload_FULL.js, which is gitignored, and the panel that
 * reads them simply does not render without them.
 *
 * To run with the real numbers locally, copy _private/neck_gload_FULL.js over
 * this file. Do not commit that copy. When the thesis is published, replace
 * this file with the real data and a citation to the published work.
 *
 * The app is built to survive this being empty -- see neckload.js, which
 * returns nothing rather than drawing an axis with no data on it.
 */
export const NECK_GLOAD_SOURCE = "";
export const NECK_MUSCLE_LABEL = {};
export const NECK_MUSCLE_FMAX = {};
export const NECK_GLOAD = null;
