#!/usr/bin/env python3
"""
bioscout_fetch.py -- an optional, local, loopback-only clip fetcher.

The app cannot download a video itself: YouTube does not serve the bytes with
permissive CORS headers, and an embedded player's pixels are unreadable from
script. This service does the download on your own device and hands the file
to the page.

    pip install yt-dlp
    pkg install ffmpeg          # Termux; apt/brew elsewhere
    python tools/bioscout_fetch.py

Then reload BioScout. The link box appears on the recording page only while
this is running.

Three deliberate limits, none of them adjustable by the page:

  * It binds 127.0.0.1 and nothing else. Loopback is the only address a
    browser will let an HTTPS page call without a certificate, and it is also
    the only one that cannot be reached from the network. Those happen to be
    the same choice, which is convenient.
  * It accepts an 11-character video id, never a URL. The page cannot talk
    this service into fetching an arbitrary address.
  * Clips are capped and files are temporary. This is a fetcher for a few
    seconds of movement, not a download manager.

On terms of use: downloading from YouTube is against their terms of service.
That is your call to make for your own footage, Creative Commons material, or
anything you hold the rights to -- which is why this lives here, as a thing
you run deliberately, rather than inside the published app.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", 8765
VERSION = 1
MAX_SECONDS = 120
ID_RE = re.compile(r"^[\w-]{11}$")

# Only the deployed app and a local dev server. A wildcard here would let any
# page you happen to have open drive the downloader.
ALLOWED_ORIGINS = {
    "https://basgoncalves.github.io",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
}

# Prefer frame rate over resolution. At 30 fps a jump's flight phase is about
# eight frames, so takeoff and landing inherit +/-33 ms; 60 fps halves that,
# and 720p60 beats 4K30 for anything time-based.
FORMAT = "bv*[ext=mp4][fps>=50]+ba/bv*[ext=mp4]+ba/b[ext=mp4]/b"


def ytdlp():
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe]
    # pip installs it as a module even when the console script is not on PATH,
    # which is the normal state of affairs in Termux.
    try:
        subprocess.run([sys.executable, "-m", "yt_dlp", "--version"],
                       capture_output=True, check=True)
        return [sys.executable, "-m", "yt_dlp"]
    except Exception:
        return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # --- plumbing ---------------------------------------------------------
    def _cors(self):
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _send(self, code, body, ctype="application/json"):
        payload = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):        # one tidy line, not two
        sys.stderr.write("  %s\n" % (fmt % args))

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path != "/health":
            return self._send(404, {"error": "not found"})
        self._send(200, {"service": "bioscout-fetch", "version": VERSION,
                         "ytdlp": bool(ytdlp()), "maxSeconds": MAX_SECONDS})

    # --- the one real endpoint -------------------------------------------
    def do_POST(self):
        if self.path != "/clip":
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"error": "bad request body"})

        vid = str(req.get("id", ""))
        if not ID_RE.match(vid):
            return self._send(400, {"error": "not a video id"})

        start, end = req.get("start"), req.get("end")
        section = None
        if start is not None and end is not None:
            try:
                start, end = float(start), float(end)
            except (TypeError, ValueError):
                return self._send(400, {"error": "bad range"})
            if not 0 <= start < end:
                return self._send(400, {"error": "bad range"})
            if end - start > MAX_SECONDS:
                return self._send(400, {"error": f"clip over {MAX_SECONDS}s"})
            section = f"*{start}-{end}"

        tool = ytdlp()
        if not tool:
            return self._send(500, {"error": "yt-dlp is not installed"})

        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "clip.%(ext)s")
            cmd = tool + ["-f", FORMAT, "--no-playlist", "--no-warnings",
                          "-o", out, f"https://www.youtube.com/watch?v={vid}"]
            if section:
                # --force-keyframes-at-cuts makes the trim land on the frame
                # asked for. Without it the cut snaps to the nearest keyframe,
                # which can be seconds away -- and every timestamp downstream
                # would then be measured from the wrong instant.
                cmd += ["--download-sections", section, "--force-keyframes-at-cuts"]

            print(f"  fetching {vid}" + (f" [{section}]" if section else ""))
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode:
                return self._send(500, {"error": last_useful_line(r.stderr)})

            files = [f for f in os.listdir(tmp) if f.startswith("clip.")]
            if not files:
                return self._send(500, {"error": "nothing was downloaded"})
            path = os.path.join(tmp, files[0])
            with open(path, "rb") as f:
                data = f.read()

        print(f"  sent {len(data) / 1e6:.1f} MB")
        self._send(200, data, "video/mp4")


def last_useful_line(stderr):
    """yt-dlp's real complaint is usually the last ERROR line; the rest is
    traceback that means nothing to somebody holding a phone."""
    lines = [l.strip() for l in (stderr or "").splitlines() if l.strip()]
    for line in reversed(lines):
        if "ERROR" in line:
            return line.split("ERROR:")[-1].strip()[:200]
    return (lines[-1][:200] if lines else "download failed")


def main():
    if not ytdlp():
        print("!! yt-dlp not found.  pip install yt-dlp", file=sys.stderr)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"bioscout-fetch on http://{HOST}:{PORT}  (loopback only, Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
