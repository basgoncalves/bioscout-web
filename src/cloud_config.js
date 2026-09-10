/**
 * cloud_config.js -- where the BioScout account server is.
 *
 * Supabase project "bioscout" (EU, Frankfurt). The key is the project's
 * PUBLISHABLE key: it identifies the project, not a user, and gives nothing
 * on its own -- every table is behind row-level security (supabase/schema.sql),
 * so a request sees only the signed-in person's rows. Safe to ship in the page.
 * Empty url = accounts switched off, local-only as before.
 */
export const CLOUD = {
  url: "https://vsgavovvsymperoikwtm.supabase.co",
  key: "sb_publishable_DS7W82DC-O-98GRcZZC4Aw_UmjsJNq_",
};
