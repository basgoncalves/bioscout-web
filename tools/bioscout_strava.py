#!/usr/bin/env python3
"""
bioscout_strava.py -- an optional, local, loopback-only Strava bridge.

The page cannot talk to Strava itself, for two independent reasons, and only
one of them is about privacy:

  * Strava's token exchange requires the application's CLIENT SECRET. A static
    site has nowhere to keep one -- shipping it in the JavaScript publishes it
    to everybody who opens the page. There is no PKCE flow to fall back on, so
    this is not a matter of doing the browser flow more carefully.
  * The API sends no CORS headers. Even holding a valid token, the browser
    would be refused at the door.

So the OAuth dance happens here, on your own device, exactly as
bioscout_fetch.py does the YouTube download the page cannot do. This is the
same shape of answer to the same shape of problem: the thing the browser is
not allowed to do is done by a process you started yourself, on loopback.

    python tools/bioscout_strava.py

First run tells you what it needs. Make a Strava API application at
https://www.strava.com/settings/api, set its Authorization Callback Domain to
127.0.0.1, then either export the two values:

    export STRAVA_CLIENT_ID=12345
    export STRAVA_CLIENT_SECRET=...

or write them to ~/.bioscout/strava.json as {"client_id": ..., "client_secret": ...}.

Then reload BioScout. The Strava button appears on the dashboard only while
this is running -- a control that cannot work is worse than no control.

Four deliberate limits, none of them adjustable by the page:

  * It binds 127.0.0.1 and nothing else.
  * It answers only the deployed app's origin, not any page you have open.
  * It NEVER hands the page a token. The page may ask for activities; it
    cannot ask for a credential, so a compromised page cannot lift one.
  * It reads. There is no scope here that can modify or delete anything on
    your Strava account.

Your data still never leaves your device: this fetches FROM Strava TO you.
"""
import json
import os
import secrets
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", 8766
VERSION = 1
REDIRECT = f"http://{HOST}:{PORT}/callback"

# Read-only, and read_all so that activities you marked "Only You" are
# included -- they are yours, and an import that silently skipped half your
# training would be worse than no import.
SCOPE = "activity:read_all"

# Strava allows 100 requests per 15 minutes. Pages are 200 activities each, so
# this ceiling is ~40 000 activities and about 20 requests -- generous for a
# person, nowhere near the limit.
PER_PAGE = 200
MAX_PAGES = 20

CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".bioscout")
CONFIG_FILE = os.path.join(CONFIG_DIR, "strava.json")
TOKEN_FILE = os.path.join(CONFIG_DIR, "strava_tokens.json")

# Only the deployed app and a local dev server, same as the fetcher. A
# wildcard would let any page you happen to have open drive this.
ALLOWED_ORIGINS = {
    "https://basgoncalves.github.io",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
}

# The fields worth carrying. Strava returns about fifty per activity and the
# page needs eight; the rest is noise in localStorage forever.
#
# `calories` is deliberately absent: it is not in the activity LIST response,
# only in the per-activity detail one, so including it would mean one request
# per activity and a rate-limit ban for a year of training. `kilojoules` is
# here because it comes free on rides with a power meter.
KEEP = ("id", "name", "sport_type", "type", "start_date", "start_date_local",
        "elapsed_time", "moving_time", "distance", "total_elevation_gain",
        "average_heartrate", "max_heartrate", "average_speed", "kilojoules",
        "trainer", "manual")

# Filled by main(); a dict so the handler can mutate it after authorising.
STATE = {"pending": None, "athlete": None}


# --- credentials and tokens ------------------------------------------------

def config():
    """Client id and secret, from the environment or the config file.

    The environment wins, so a shell export can override a stale file without
    anyone having to remember where the file lives.
    """
    cid = os.environ.get("STRAVA_CLIENT_ID", "").strip()
    sec = os.environ.get("STRAVA_CLIENT_SECRET", "").strip()
    if cid and sec:
        return cid, sec
    try:
        with open(CONFIG_FILE) as f:
            j = json.load(f)
        return str(j.get("client_id", "")).strip(), str(j.get("client_secret", "")).strip()
    except Exception:
        return cid, sec


def load_tokens():
    try:
        with open(TOKEN_FILE) as f:
            return json.load(f)
    except Exception:
        return None


def save_tokens(tok):
    """Written 0600. These are as good as a password for reading your account,
    and a world-readable file on a shared machine is a quiet mistake."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    tmp = TOKEN_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(tok, f)
    try:
        os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass                      # Windows; the directory is per-user anyway
    os.replace(tmp, TOKEN_FILE)


def post_form(url, fields):
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def exchange(code):
    cid, sec = config()
    tok = post_form("https://www.strava.com/oauth/token", {
        "client_id": cid, "client_secret": sec,
        "code": code, "grant_type": "authorization_code",
    })
    save_tokens(tok)
    return tok


def access_token():
    """A live token, refreshed if it is about to expire.

    Strava rotates the refresh token on every refresh and invalidates the old
    one immediately, so the new pair must be saved before it is used -- a
    crash between refreshing and saving would otherwise lock the helper out
    permanently and require re-authorising by hand.
    """
    tok = load_tokens()
    if not tok:
        return None
    if tok.get("expires_at", 0) > time.time() + 120:
        return tok["access_token"]
    cid, sec = config()
    fresh = post_form("https://www.strava.com/oauth/token", {
        "client_id": cid, "client_secret": sec,
        "grant_type": "refresh_token", "refresh_token": tok["refresh_token"],
    })
    # Strava's refresh response omits athlete; keep what we already knew.
    merged = {**tok, **fresh}
    save_tokens(merged)
    return merged["access_token"]


def api_get(path, params, token):
    url = f"https://www.strava.com/api/v3{path}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def activities(after=None):
    """Every activity since `after` (unix seconds), newest page last.

    Paged rather than fetched whole: a decade of training is thousands of
    activities, and asking for them in one request is how you discover Strava's
    rate limit.
    """
    token = access_token()
    if not token:
        return None
    out, page = [], 1
    while page <= MAX_PAGES:
        params = {"per_page": PER_PAGE, "page": page}
        if after:
            params["after"] = int(after)
        batch = api_get("/athlete/activities", params, token)
        if not batch:
            break
        out.extend({k: a.get(k) for k in KEEP} for a in batch)
        if len(batch) < PER_PAGE:
            break
        page += 1
    return out


# --- the server ------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

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

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)

        if u.path == "/health":
            cid, sec = config()
            tok = load_tokens()
            athlete = (tok or {}).get("athlete") or STATE["athlete"] or {}
            return self._send(200, {
                "service": "bioscout-strava", "version": VERSION,
                "configured": bool(cid and sec),
                "authorised": bool(tok),
                # A first name is enough to show whose account is connected.
                # There is no reason for the page to hold an athlete id.
                "athlete": athlete.get("firstname") or None,
            })

        if u.path == "/callback":
            # Strava sends the person back here after they approve. The state
            # must match the one we generated: without that check, any page
            # could walk somebody through authorising an attacker's app.
            if q.get("state", [""])[0] != (STATE["pending"] or "\x00"):
                return self._send(400, b"<h3>Unexpected callback. Start again from the app.</h3>",
                                  "text/html; charset=utf-8")
            STATE["pending"] = None
            err = q.get("error", [""])[0]
            if err:
                return self._send(400, f"<h3>Strava said: {err}</h3>".encode(),
                                  "text/html; charset=utf-8")
            try:
                tok = exchange(q.get("code", [""])[0])
            except urllib.error.HTTPError as e:
                return self._send(502, f"<h3>Token exchange failed ({e.code}).</h3>".encode(),
                                  "text/html; charset=utf-8")
            STATE["athlete"] = tok.get("athlete") or {}
            name = (STATE["athlete"] or {}).get("firstname", "")
            print(f"  authorised{' as ' + name if name else ''}")
            return self._send(200, b"<h3>BioScout is connected to Strava.</h3>"
                                   b"<p>You can close this tab and go back to the app.</p>",
                              "text/html; charset=utf-8")

        if u.path == "/activities":
            cid, sec = config()
            if not (cid and sec):
                return self._send(500, {"error": "notConfigured"})
            if not load_tokens():
                return self._send(401, {"error": "notAuthorised"})
            after = q.get("after", [None])[0]
            try:
                acts = activities(after)
            except urllib.error.HTTPError as e:
                # 401 here means the refresh token was revoked from Strava's
                # side. Saying so is more use than "request failed".
                if e.code == 401:
                    return self._send(401, {"error": "notAuthorised"})
                if e.code == 429:
                    return self._send(429, {"error": "rateLimited"})
                return self._send(502, {"error": f"strava {e.code}"})
            except urllib.error.URLError:
                return self._send(502, {"error": "offline"})
            print(f"  sent {len(acts)} activities")
            return self._send(200, {"activities": acts})

        self._send(404, {"error": "not found"})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)

        if u.path == "/auth":
            cid, sec = config()
            if not (cid and sec):
                return self._send(500, {"error": "notConfigured"})
            STATE["pending"] = secrets.token_urlsafe(16)
            url = "https://www.strava.com/oauth/authorize?" + urllib.parse.urlencode({
                "client_id": cid, "redirect_uri": REDIRECT, "response_type": "code",
                "approval_prompt": "auto", "scope": SCOPE, "state": STATE["pending"],
            })
            print("  opening Strava for approval")
            # Printed as well as opened: a headless or Termux session has no
            # browser to open, and the person can paste it themselves.
            print(f"  {url}")
            try:
                webbrowser.open(url)
            except Exception:
                pass
            return self._send(200, {"opened": True})

        if u.path == "/logout":
            try:
                os.remove(TOKEN_FILE)
            except FileNotFoundError:
                pass
            STATE["athlete"] = None
            print("  tokens deleted")
            return self._send(200, {"authorised": False})

        self._send(404, {"error": "not found"})


def main():
    cid, sec = config()
    if not (cid and sec):
        print("!! No Strava credentials found.\n"
              "   Make an app at https://www.strava.com/settings/api\n"
              "   (Authorization Callback Domain: 127.0.0.1), then either:\n"
              "     export STRAVA_CLIENT_ID=...  STRAVA_CLIENT_SECRET=...\n"
              f"   or write them to {CONFIG_FILE}", file=sys.stderr)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"bioscout-strava on http://{HOST}:{PORT}  (loopback only, Ctrl+C to stop)")
    if load_tokens():
        print("  already authorised; the app can import straight away")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
