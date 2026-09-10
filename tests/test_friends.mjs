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

/* Profile pictures: one file per account at <uid>/avatar.jpg. */
{
  const { avatarPath } = await import("../src/cloud.js");
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, method: init.method, body: init.body });
    if (url.includes("/object/sign/")) {
      return { ok: true, status: 200, text: async () => JSON.stringify([
        { path: "u2/avatar.jpg", signedURL: "/object/sign/posts/u2/avatar.jpg?token=a", error: null },
        { path: "u3/avatar.jpg", signedURL: null, error: "Either the object does not exist" }]) };
    }
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const cloud = makeCloud({ url: "https://x.supabase.co", key: "k", fetchImpl: fake });
  const login = { access_token: "t", user: { id: "me" } };
  ok(avatarPath("me") === "me/avatar.jpg", "a profile picture sits in your own media folder");
  await cloud.setAvatar(login, new Blob(["x"], { type: "image/jpeg" }));
  ok(seen[0].method === "DELETE" && seen[1].method === "POST" && seen[1].url.endsWith("/posts/me/avatar.jpg"),
     "setting it removes the old one, then uploads the new one to the same place");
  const urls = await cloud.avatarUrls(login, ["u2", "u3", "u2", null]);
  ok(Object.keys(urls).join() === "u2" && urls.u2.startsWith("https://x.supabase.co/storage/v1/object/sign/"),
     "links come back for the pictures that exist and you may see; the rest are left out");
  const signReq = seen.find((x) => x.url.includes("/object/sign/"));
  ok(JSON.parse(signReq.body).paths.length === 2, "asked once per account, not once per post");
}

console.log(bad ? `\n${bad} check(s) failed` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
