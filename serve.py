#!/usr/bin/env python3
"""
serve.py -- run the app from THIS folder, without pushing anything.

    python serve.py            then open  http://localhost:8000
    python serve.py 5173 --open "?lab=1#viewBiofeedback"   serve and open that page

If the port is already taken it does NOT start a second server (on Windows a
second one can silently share the port and an old copy of the app answers);
it opens a local "Another server already running" page instead, saying who
holds the port. Put a picture at _private/launchers/busy.png to show on it.

Why this exists: every fix in this repo was being tested by pushing it to
GitHub Pages and waiting, which is slow, public, and puts half-finished work on
a live site. This serves the working tree instead, so what you see is the file
you just edited.

Two things it does that `python -m http.server` does not:

  * No caching. The service worker plus GitHub Pages' ten-minute cache is the
    reason a deployed fix could take several reloads to appear; here every
    response says "do not store this", so a reload is always the current file.
  * Camera works. getUserMedia needs a secure context, and browsers count
    http://localhost as one -- but only localhost, so open it by that name and
    not by 127.0.0.1 or a LAN address.

To test from a PHONE on the same network you need HTTPS, because the phone is
not localhost. Easiest is a tunnel, e.g. `npx localtunnel --port 8000` or
`cloudflared tunnel --url http://localhost:8000`, both of which hand you an
https:// address the phone can open.
"""
import http.server, socketserver, sys, os, json, socket, subprocess, webbrowser, urllib.request, html, pathlib

args = [a for a in sys.argv[1:] if not a.startswith("--")]
PORT = int(args[0]) if args else 8000
OPEN = None                       # --open PATH : open the browser here once serving
for i, a in enumerate(sys.argv):
    if a == "--open" and i + 1 < len(sys.argv):
        OPEN = sys.argv[i + 1]
ROOT = os.path.dirname(os.path.abspath(__file__))


def branch():
    try:
        return subprocess.run(["git", "branch", "--show-current"], cwd=ROOT, capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""


def who_is_on(port):
    """None if the port is free; else {} (unknown program) or what a BioScout serve.py says about itself."""
    with socket.socket() as s:
        s.settimeout(0.5)
        if s.connect_ex(("127.0.0.1", port)) != 0:
            return None
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/__bioscout_whoami", timeout=1.5) as r:
            return json.loads(r.read().decode())
    except Exception:
        return {}                 # something answers, but not a newer serve.py (an old one, or another app)


def busy_page(port, other):
    """Write a local error page and open it, instead of letting the browser show whatever the
    other server serves (often an old copy of the app)."""
    here = pathlib.Path(ROOT, "_private", "launchers")
    img = next((p for p in [here / "busy.png", here / "busy.jpg", here / "busy.gif", here / "busy.webp"] if p.exists()), None)
    pic = (f'<img src="{img.as_uri()}" alt="" style="max-width:340px;max-height:340px;border-radius:12px">' if img else
           '<svg width="180" height="140" viewBox="0 0 180 140" aria-hidden="true"><g fill="none" stroke="#e8823a" stroke-width="8" stroke-linecap="round">'
           '<path d="M20 70h40M60 50v40M60 50h22a20 20 0 0 1 0 40H60"/><path d="M160 70h-40M120 50v40M120 50H98M120 90H98M98 58v-8M98 90v-8"/></g>'
           '<path d="M86 30l6 14M94 22v16M102 30l-6 14" stroke="#ffd54a" stroke-width="5" stroke-linecap="round"/></svg>')
    if other.get("root"):
        what = f"BioScout from <code>{html.escape(other['root'])}</code> (branch <b>{html.escape(other.get('branch') or '?')}</b>)"
    else:
        what = "another program (an older BioScout window, or something else)"
    page = f"""<!doctype html><meta charset="utf-8"><title>Another server already running</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#14171c;color:#e8e8e8;font:16px/1.5 system-ui,sans-serif">
<div style="max-width:620px;padding:32px;text-align:center">{pic}
<h1 style="font-size:26px;margin:18px 0 8px">Another server already running</h1>
<p>Port <b>{port}</b> is already used by {what}.<br>This launcher wanted to serve <code>{html.escape(ROOT)}</code> (branch <b>{html.escape(branch() or '?')}</b>),
so what you would see in the browser is <i>not</i> this folder.</p>
<p style="color:#aaa">Close the other server's black window (or press Ctrl+C in it), then run the launcher again.<br>
Or run this one on another port: <code>python serve.py 5174</code>.</p></div></body>"""
    out = here / "server_busy.html" if here.exists() else pathlib.Path(ROOT, "server_busy.html")
    out.write_text(page, encoding="utf-8")
    webbrowser.open(out.as_uri())


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/__bioscout_whoami":     # lets the next launcher see who holds the port
            body = json.dumps({"root": ROOT, "branch": branch()}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        # The whole point: never let anything be cached between edits.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # One line per request, without the date noise.
        sys.stderr.write("  %s\n" % (fmt % args))


os.chdir(ROOT)
other = who_is_on(PORT)
if other is not None:
    if other.get("root") and os.path.normcase(other["root"]) == os.path.normcase(ROOT):
        # The same folder is already being served: just open it, nothing to start.
        print(f"\n  Already serving this folder on http://localhost:{PORT} - opening it.\n")
        if OPEN is not None:
            webbrowser.open(f"http://localhost:{PORT}/{OPEN.lstrip('/')}")
        sys.exit(0)
    print(f"\n  ANOTHER SERVER ALREADY RUNNING on port {PORT}: " + (other.get("root") or "unknown program"))
    print("  Close it (its window, or Ctrl+C) and run this again, or use another port.\n")
    busy_page(PORT, other)
    sys.exit(1)

# On Windows SO_REUSEADDR lets a SECOND server bind the same port and steal some
# requests -- which is how an old copy of the app could answer. Only use it elsewhere.
socketserver.TCPServer.allow_reuse_address = os.name != "nt"
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"\n  BioScout, served from this folder, nothing cached")
    print(f"  http://localhost:{PORT}\n")
    print("  Camera works on localhost. For a phone you need an https tunnel;")
    print("  see the notes at the top of this file.\n")
    if OPEN is not None:
        webbrowser.open(f"http://localhost:{PORT}/{OPEN.lstrip('/')}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped\n")
