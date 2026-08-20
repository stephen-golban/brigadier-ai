// Throwaway. Does `process.ppid` re-read getppid() on every access, on THIS
// platform and this bun? `bar/lib/orphan.ts`'s whole guard depends on it, and
// the claim in its header was measured on darwin only.
const parent = process.ppid;
const started = Date.now();
process.stderr.write(`start: ppid=${parent} pid=${process.pid}\n`);
const timer = setInterval(() => {
  const now = process.ppid;
  if (now !== parent) {
    process.stderr.write(`CHANGED after ${Date.now() - started} ms: ${parent} -> ${now}\n`);
    process.exit(0);
  }
  if (Date.now() - started > 20_000) {
    process.stderr.write(`UNCHANGED after 20000 ms: still ${process.ppid}; /proc says ppid=${ppidFromProc()}\n`);
    process.exit(3);
  }
}, 250);
timer.unref();
function ppidFromProc(): string {
  try {
    const stat = require("node:fs").readFileSync(`/proc/${process.pid}/stat`, "utf8") as string;
    return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[1] ?? "?";
  } catch {
    return "no /proc";
  }
}
// Keep the loop alive on something that is not the unref'd timer, exactly as the
// real vendor is kept alive by reading stdin.
setInterval(() => {}, 1000);
