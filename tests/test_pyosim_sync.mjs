// py/pyosim must be an exact copy of bioscout.pyosim (the source of truth).
// Skips when the bioscout checkout is not next to this one (e.g. CI on this repo alone).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(root, "..", "bioscout", "bioscout", "pyosim");
if (!existsSync(src)) {
  console.log("skip: ../bioscout/bioscout/pyosim not found");
} else {
  for (const py of ["python", "python3", "py"]) {
    try {
      execFileSync(py, [path.join(root, "tools", "sync_pyosim.py"), "--check", "--src", src], { stdio: "inherit" });
      console.log("ok: py/pyosim matches bioscout.pyosim");
      break;
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw new Error("py/pyosim is out of sync with bioscout.pyosim -- run python tools/sync_pyosim.py");
    }
  }
}
