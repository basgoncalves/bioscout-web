"""Copy pyosim from the bioscout package (the one source of truth) into py/pyosim.

bioscout/bioscout/pyosim is edited; this site serves a copy so it stays a static,
offline-cacheable page with no PyPI fetch at runtime.

    python tools/sync_pyosim.py            # copy ../bioscout/bioscout/pyosim -> py/pyosim
    python tools/sync_pyosim.py --check    # exit 1 if the copy is out of date
    python tools/sync_pyosim.py --src PATH # bioscout checkout somewhere else
"""
import argparse, filecmp, shutil, sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
DST = HERE / "py" / "pyosim"


def files(d):
    return {p.name for p in Path(d).glob("*.py")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(HERE.parent / "bioscout" / "bioscout" / "pyosim"))
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    src = Path(a.src)
    if not src.is_dir():
        print(f"bioscout pyosim not found at {src} (pass --src)"); return 2 if not a.check else 0
    names = files(src) | files(DST)
    stale = sorted(n for n in names if not (src / n).exists() or not (DST / n).exists()
                   or not filecmp.cmp(src / n, DST / n, shallow=False))
    if a.check:
        if stale:
            print("py/pyosim differs from bioscout.pyosim: " + ", ".join(stale)
                  + "\n  run: python tools/sync_pyosim.py"); return 1
        print("py/pyosim matches bioscout.pyosim"); return 0
    for n in stale:
        if (src / n).exists():
            shutil.copy2(src / n, DST / n); print("copied", n)
        else:
            print(f"{n} is only in py/pyosim: not in bioscout.pyosim -- move it there or delete it")
    print("in sync" if not stale else "done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
