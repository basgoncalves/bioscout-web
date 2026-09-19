/**
 * serve.mjs -- a static server rooted at the repo, for the harness page.
 *
 * Why a server at all: the vendored MediaPipe bundle is an ES module and the
 * .task/.wasm files are fetched, so file:// is out. Rooted at the REPO, not at
 * this folder, so the page loads the very same assets/vendor/ files the app
 * ships -- a benchmark against a separately downloaded copy of MediaPipe would
 * be measuring a different program from the one users run.
 */

import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const TYPES = {
  ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript",
  ".json": "application/json", ".wasm": "application/wasm",
  ".task": "application/octet-stream", ".mp4": "video/mp4",
  ".webm": "video/webm", ".mov": "video/quicktime", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".data": "application/octet-stream",
};

export function serveRepo(root, port = 0) {
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    const path = join(root, normalize(url).replace(/^(\.\.[/\\])+/, ""));
    if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
    let st;
    try { st = statSync(path); } catch { res.writeHead(404).end("not found: " + url); return; }
    if (st.isDirectory()) { res.writeHead(403).end(); return; }
    const type = TYPES[extname(path).toLowerCase()] || "application/octet-stream";

    // Range support: the <video> element asks for one, and Chromium will not
    // seek reliably in a response that ignores it.
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range && st.size) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : st.size - 1;
      res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes",
                           "Content-Range": `bytes ${start}-${end}/${st.size}`,
                           "Content-Length": end - start + 1 });
      createReadStream(path, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size,
                         "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
    createReadStream(path).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, port: server.address().port,
                close: () => new Promise((r) => server.close(r)) });
    });
  });
}
