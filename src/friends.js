/**
 * friends.js -- the pure half of friends: sorting the server's list into what
 * the Friends page shows, and what a search result's button should say.
 *
 * Friends are mutual (one asks, the other accepts) and live on the server
 * (public.friendships; cloud.js calls it). A friend sees your posts even when
 * your account is private, and your username. Nothing from your logs --
 * training or health -- is ever shared with friends; that stays in `records`,
 * readable by its owner alone.
 *
 * Pure, so tests/test_friends.mjs runs it in node.
 */

/** my_friends() rows split into the page's three lists, each by username. */
export function groupFriends(rows) {
  const by = (a, b) => String(a.username || "").localeCompare(String(b.username || ""));
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.id) : [];
  return {
    incoming: list.filter((r) => r.status === "pending" && !r.outgoing).sort(by),
    outgoing: list.filter((r) => r.status === "pending" && r.outgoing).sort(by),
    friends: list.filter((r) => r.status === "accepted").sort(by),
  };
}

/** Where a search result stands with you: "friend" | "sent" | "incoming" | "none". */
export function relationTo(id, rows) {
  const r = (Array.isArray(rows) ? rows : []).find((x) => x && x.id === id);
  if (!r) return "none";
  if (r.status === "accepted") return "friend";
  return r.outgoing ? "sent" : "incoming";
}

/** What the person typed, as a search: lower case, no leading @, trimmed.
 *  Null when it is too short to search on (the server wants two characters). */
export function searchTerm(q) {
  const s = String(q ?? "").trim().replace(/^@+/, "").toLowerCase();
  return s.length >= 2 ? s : null;
}
