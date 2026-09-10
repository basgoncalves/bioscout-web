/**
 * cloud_config.js -- where the BioScout account server is.
 *
 * The anon key is PUBLIC by design: it identifies the project, not a user, and
 * gives nothing on its own -- every table is behind row-level security
 * (supabase/schema.sql), so a request sees only the signed-in person's rows.
 * Empty url = accounts are switched off and the app is local-only, as before.
 */
export const CLOUD = {
  url: "",
  key: "",
};
