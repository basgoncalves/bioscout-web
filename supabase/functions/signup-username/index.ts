// signup-username -- create a BioScout login from a plain username + password.
//
// Supabase auth needs an email behind every account. A username-only account
// gets `<username>@users.bioscout.invalid` (a reserved domain: nothing is ever
// sent there) and is created ALREADY CONFIRMED, because there is no inbox to
// confirm from. That is why this runs server-side with the service role, and
// why email sign-ups can keep their confirmation mail. The price, said on the
// sign-up screen: a username-only account cannot reset a forgotten password.
//
// Deployed with verify_jwt = false: it is called before anyone is signed in.
import { createClient } from "npm:@supabase/supabase-js@2";

const DOMAIN = "users.bioscout.invalid";
const NAME = /^[a-z0-9_.]{3,24}$/;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { code: "method", message: "POST only" });
  let body: { username?: string; password?: string };
  try { body = await req.json(); } catch { return reply(400, { code: "bad_json", message: "Bad request" }); }
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!NAME.test(username)) {
    return reply(400, { code: "bad_username", message: "3-24 characters: a-z, 0-9, _ or ." });
  }
  if (password.length < 8) return reply(400, { code: "weak_password", message: "At least 8 characters" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
                             { auth: { persistSession: false } });
  const { data: taken } = await admin.from("accounts").select("id").eq("username", username).maybeSingle();
  if (taken) return reply(409, { code: "username_taken", message: "That username is taken" });

  const { error } = await admin.auth.admin.createUser({
    email: `${username}@${DOMAIN}`,
    password,
    email_confirm: true,
    user_metadata: { username },
  });
  if (error) {
    const dup = /already|registered|exists/i.test(error.message);
    return reply(dup ? 409 : 400, { code: dup ? "username_taken" : "signup_failed", message: error.message });
  }
  return reply(200, { ok: true });
});
