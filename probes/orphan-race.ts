// Throwaway. Is `bar/lib/orphan.ts`'s guard installable AFTER the process has
// already been orphaned? `if (parent <= 1) return;` says no, and the question is
// whether the bar's own test can lose that race on a loaded machine.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VENDOR = fileURLToPath(new URL("../bar/fakes/vendor.ts", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "orphan-race-"));
const killAfterMs = Number(process.argv[2] ?? "0");

const config = join(scratch, "copilot.vendor.json");
writeFileSync(config, JSON.stringify({ id: "copilot", version: "1.0.80" }, null, 2));
const fifo = join(scratch, "in.fifo");
const vendorPidFile = join(scratch, "vendor.pid");
const errLog = join(scratch, "vendor.err");
const script = join(scratch, "parent.sh");
writeFileSync(
  script,
  [
    "#!/bin/sh",
    `mkfifo ${JSON.stringify(fifo)}`,
    `sleep 300 > ${JSON.stringify(fifo)} &`,
    `${JSON.stringify(process.execPath)} ${JSON.stringify(VENDOR)} ${JSON.stringify(config)} --acp < ${JSON.stringify(fifo)} 2> ${JSON.stringify(errLog)} &`,
    `echo $! > ${JSON.stringify(vendorPidFile)}`,
    "sleep 300",
  ].join("\n"),
  { mode: 0o755 },
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 1).trim().charAt(0) !== "Z";
  } catch {
    return true;
  }
}

const parent = Bun.spawn(["/bin/sh", script], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
const deadline = Date.now() + 10_000;
while (!existsSync(vendorPidFile) && Date.now() < deadline) await Bun.sleep(5);
const vendorPid = Number(readFileSync(vendorPidFile, "utf8").trim());
await Bun.sleep(killAfterMs);
parent.kill("SIGKILL");
const killedAt = Date.now();
while (alive(vendorPid) && Date.now() - killedAt < 20_000) await Bun.sleep(50);
const survived = alive(vendorPid);
console.log(
  JSON.stringify({
    killAfterMs,
    vendorPid,
    survived20s: survived,
    exitedAfterMs: survived ? null : Date.now() - killedAt,
    stderr: existsSync(errLog) ? readFileSync(errLog, "utf8").trim().slice(0, 200) : "<none>",
  }),
);
try {
  process.kill(-parent.pid, "SIGKILL");
} catch {}
try {
  process.kill(vendorPid, "SIGKILL");
} catch {}
rmSync(scratch, { recursive: true, force: true });
