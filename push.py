#!/usr/bin/env python3
"""push.py -- apply a patch from the clipboard and ship it, from a phone.

    python push.py doctor            state, and clear a stuck `git am`
    python push.py apply -b BRANCH   clipboard -> commit (no push)
    python push.py ship -b BRANCH    apply, then push and open a PR
    python push.py test              just run the suite

Add --file PATH to read from a file, or --file - for stdin.
Input may be a raw patch, base64, gzipped base64, or a <<'B64' heredoc.
"""
import argparse, base64, binascii, gzip, os, re, shutil, subprocess, sys

REPO = os.path.dirname(os.path.abspath(__file__))
NAME = "Bas Goncalves"
EMAIL = "basgoncalves@users.noreply.github.com"


def run(*a, check=True, quiet=False):
    p = subprocess.run(a, cwd=REPO, capture_output=True, text=True)
    out = (p.stdout or "") + (p.stderr or "")
    if not quiet and out.strip():
        print(out.rstrip())
    if check and p.returncode:
        die("`%s` failed" % " ".join(a))
    return p.returncode, out


def git(*a, **kw):
    return run("git", *a, **kw)


def say(m):
    print("\n== " + m)


def die(m):
    print("\n!! " + m, file=sys.stderr)
    sys.exit(1)


def clipboard():
    if not shutil.which("termux-clipboard-get"):
        die("termux-clipboard-get missing.\n"
            "   pkg install termux-api  (plus the Termux:API app from F-Droid)\n"
            "   or use:  python push.py ship --file patch.txt")
    p = subprocess.run(["termux-clipboard-get"], capture_output=True, text=True)
    if p.returncode:
        die("could not read clipboard: " + (p.stderr or "").strip())
    return p.stdout


def unwrap(text):
    """Whatever got pasted -> patch bytes. Tried in order, never guessed."""
    if not text or not text.strip():
        die("nothing on the clipboard")
    m = re.search(r"<<'B64'[^\n]*\n(.*?)\nB64", text, re.S)
    if m:
        text = m.group(1)
    s = text.strip()
    if s.startswith(("From ", "diff --git", "---")):
        return s.encode() + b"\n"
    try:
        raw = base64.b64decode("".join(s.split()), validate=True)
    except (binascii.Error, ValueError):
        die("not a patch and not base64 -- check what got copied")
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    if not raw.lstrip().startswith((b"From ", b"diff --git", b"---")):
        die("decoded, but the result is not a patch")
    return raw


def read_patch(args):
    if args.file == "-":
        return unwrap(sys.stdin.read())
    if args.file:
        return unwrap(open(args.file, encoding="utf-8", errors="replace").read())
    return unwrap(clipboard())


def clean_stale_am():
    """An interrupted `git am` leaves .git/rebase-apply behind and every later
    am refuses. Clearing it is safe: its commits were never created."""
    d = os.path.join(REPO, ".git", "rebase-apply")
    if os.path.isdir(d):
        say("clearing a half-finished git am")
        git("am", "--abort", check=False, quiet=True)
        shutil.rmtree(d, ignore_errors=True)
        return True
    return False


def ensure_identity():
    if git("config", "user.email", check=False, quiet=True)[0]:
        say("setting commit identity")
        git("config", "user.name", NAME)
        git("config", "user.email", EMAIL)


def dirty():
    """Ignores push.py itself, which lives here untracked and must not be the
    thing that blocks every apply."""
    out = git("status", "--porcelain", check=False, quiet=True)[1]
    return bool([l for l in out.splitlines()
                 if l.strip() and not l[3:].strip().endswith("push.py")])


def branch():
    return git("rev-parse", "--abbrev-ref", "HEAD", check=False, quiet=True)[1].strip()


def npm_test():
    if not os.path.exists(os.path.join(REPO, "package.json")):
        say("no package.json on this branch yet -- skipping tests")
        return True
    say("running the tests")
    return run("npm", "test", check=False)[0] == 0


def do_apply(args):
    clean_stale_am()
    ensure_identity()
    if dirty():
        die("uncommitted changes here.\n   Keep them: git stash\n"
            "   Bin them:  git checkout .")
    patch = read_patch(args)
    came, made = branch(), False
    if args.branch and args.branch != came:
        say("branch " + args.branch)
        code = git("checkout", "-b", args.branch, check=False, quiet=True)[0]
        made = code == 0
        if code:
            git("checkout", args.branch)
    say("applying")
    p = subprocess.run(["git", "am", "--3way"], cwd=REPO, input=patch,
                       capture_output=True)
    print(((p.stdout or b"") + (p.stderr or b"")).decode().rstrip())
    if p.returncode:
        git("am", "--abort", check=False, quiet=True)
        if made:
            git("checkout", came, check=False, quiet=True)
            git("branch", "-D", args.branch, check=False, quiet=True)
        die("patch did not apply -- most likely it needs a commit you don't "
            "have yet.\n   Try: git checkout main && git pull, then rerun.")
    if not npm_test():
        die("tests failed. Committed but NOT pushed.\n"
            "   Undo with: git reset --hard HEAD~1")
    say("applied and green")


def cmd_doctor(args):
    cleaned = clean_stale_am()
    ensure_identity()
    say("state")
    print("   branch: %s" % branch())
    print("   dirty:  %s" % ("yes" if dirty() else "no"))
    git("log", "--oneline", "-3")
    if cleaned:
        print("\n   A stuck git am was cleared.")
    print("\n   tests: %s" % ("pass" if npm_test() else "FAIL"))


def cmd_ship(args):
    if not args.skip_apply:
        do_apply(args)
    b = branch()
    if b in ("main", "master"):
        die("refusing to push straight to %s -- rerun with -b a-branch-name" % b)
    say("pushing " + b)
    git("push", "-u", "origin", b)
    if shutil.which("gh"):
        say("opening a pull request")
        code, out = run("gh", "pr", "create", "--fill", check=False)
        if code and "already exists" not in out:
            print("   (open the PR from the link above)")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd")
    for n in ("apply", "ship"):
        p = sub.add_parser(n)
        p.add_argument("--file")
        p.add_argument("-b", "--branch")
        if n == "ship":
            p.add_argument("--skip-apply", action="store_true")
    sub.add_parser("doctor")
    sub.add_parser("test")
    a = ap.parse_args()
    if not a.cmd:
        ap.print_help()
        return
    {"apply": do_apply, "ship": cmd_ship, "doctor": cmd_doctor,
     "test": lambda _: sys.exit(0 if npm_test() else 1)}[a.cmd](a)


if __name__ == "__main__":
    main()
