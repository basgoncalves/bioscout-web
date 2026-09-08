#!/usr/bin/env python3
"""
serve.py -- run the app from THIS folder, without pushing anything.

    python serve.py            then open  http://localhost:8000

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
import http.server, socketserver, sys, os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # The whole point: never let anything be cached between edits.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # One line per request, without the date noise.
        sys.stderr.write("  %s\n" % (fmt % args))

os.chdir(os.path.dirname(os.path.abspath(__file__)))
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"\n  BioScout, served from this folder, nothing cached")
    print(f"  http://localhost:{PORT}\n")
    print("  Camera works on localhost. For a phone you need an https tunnel;")
    print("  see the notes at the top of this file.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped\n")
