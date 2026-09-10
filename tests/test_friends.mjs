/**
 * friends.js -- sorting the friends list and labelling search results.
 *
 *   node tests/test_friends.mjs
 */
import { groupFriends, relationTo, searchTerm } from "../src/friends.js";
import { makeCloud, CloudError } from "../src/cloud.js";

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!cond) bad++;
};

const rows = [
  { id: "a", username: "zoe", status: "accepted", outgoing: false },
  { id: "b", username: "ana", status: "accepted", outgoing: true },
  { id: "c", username: "max", status: "pending", outgoing: false },
  { id: "d", username: "lea", status: "pending", outgoing: true },
];
const g = groupFriends(rows);
ok(g.friends.map((r) => r.username).join() === "ana,zoe", "accepted either way round are friends, by name");
ok(g.incoming.length === 1 && g.incoming[0].username === "max", "a request to you is incoming");
ok(g.outgoing.length === 1 && g.outgoing[0].username === "lea", "a request you sent is outgoing");
ok(groupFriends(null).friends.length === 0, "no list is three empty lists");

ok(relationTo("a", rows) === "friend" && relationTo("c", rows) === "incoming"
   && relationTo("d", rows) === "sent" && relationTo("x", rows) === "none", "a search result's standing");

ok(searchTerm("  @Bas ") === "bas", "search: trimmed, no @, lower case");
ok(searchTerm("b") === null && searchTerm("@") === null, "one character is too short to search");

/* The cloud calls: the right endpoint, the right body, the right errors. */
{
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, init });
    if (url.includes("/rest/v1/accounts")) {
      return { ok: false, status: 409, text: async () => JSON.stringify({ code: "23505", message: "duplicate key" }) };
    }
    const body = url.endsWith("request_friend") ? '"sent"' : "[]";
    return { ok: true, status: 200, text: async () => body };
  };
  const cloud = makeCloud({ url: "https://x.supabase.co", key: "k", fetchImpl: fake });
  const login = { access_token: "t", user: { id: "me" } };
  ok(await cloud.requestFriend(login, "@ana") === "sent", "request_friend returns what happened");
  const req = seen.find((x) => x.url.endsWith("/rpc/request_friend"));
  ok(req && JSON.parse(req.init.body).p_username === "@ana", "the username goes to the server as typed");
  await cloud.friends(login);
  ok(seen.some((x) => x.url.endsWith("/rpc/my_friends")), "the list comes from my_friends");
  let code = null;
  try { await cloud.setUsername(login, "Ana"); } catch (e) { code = e.code; }
  ok(code === "username_taken", "a taken username says so", String(code));
  code = null;
  try { await cloud.setUsername(login, "a b"); } catch (e) { code = e instanceof CloudError && e.code; }
  ok(code === "bad_username", "a malformed one never reaches the server");
}

console.log(bad ? `\n${bad} check(s) failed` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
