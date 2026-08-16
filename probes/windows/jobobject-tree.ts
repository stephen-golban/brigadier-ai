/**
 * Probe — ticket #5. Does killing a Bun-spawned child kill its GRANDCHILDREN?
 *
 * Decision 5 claims Bun's Windows Job Objects with KILL_ON_JOB_CLOSE reliably
 * take down an agent's whole process tree. v1 reproduced a POSIX descendant
 * escaping `kill(-pid)` via `setsid`, so the Windows equivalent is measured,
 * not assumed. The shape here is deliberately the hard case: brigadier spawns a
 * *bridge*, and the bridge spawns the actual agent — the grandchild is the
 * thing that costs money if it survives.
 *
 * Writes a heartbeat file from the grandchild once a second. After the kill we
 * record the file's mtime, wait, and read it again: if it moved, the grandchild
 * outlived the kill.
 *
 * Negative control is built in — `--no-kill` skips the kill entirely and must
 * report SURVIVED, otherwise the detector cannot tell the two apart.
 *
 * Modes:
 *   (default)   Bun.spawn + child.kill()          — what brigadier would do naively
 *   --group     node:child_process detached + kill(-pgid) / taskkill /T
 *   --no-kill   negative control, must report SURVIVED
 *
 * Usage: bun jobobject-tree.ts [--group] [--no-kill]
 */

import { mkdirSync, statSync, existsSync, rmSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const noKill = Bun.argv.includes("--no-kill");
const useGroup = Bun.argv.includes("--group");
const dir = join(tmpdir(), `brig-job-${process.pid}`);
mkdirSync(dir, { recursive: true });

const beat = join(dir, "heartbeat.txt");
const grandchildSrc = join(dir, "grandchild.ts");
const childSrc = join(dir, "child.ts");

// Grandchild: the process that must die. Touches a file forever.
await Bun.write(
  grandchildSrc,
  `let n = 0;
setInterval(async () => { await Bun.write(${JSON.stringify(beat)}, String(++n)); }, 250);
setTimeout(() => process.exit(0), 120_000);
`,
);

// Child: the "bridge". Spawns the grandchild and then just sits there. Uses
// detached where the platform offers it, because that is the escape we are
// trying to catch.
await Bun.write(
  childSrc,
  `Bun.spawn(["${process.execPath.replace(/\\/g, "\\\\")}", ${JSON.stringify(grandchildSrc)}], {
     stdio: ["ignore", "ignore", "ignore"],
   });
   setTimeout(() => process.exit(0), 120_000);
`,
);

// Two spawn shapes: the naive one, and the one that claims to contain a tree.
const child = useGroup
  ? nodeSpawn(process.execPath, [childSrc], { detached: true, stdio: "ignore" })
  : Bun.spawn([process.execPath, childSrc], { stdio: ["ignore", "ignore", "ignore"] });
const childPid = child.pid!;

// Wait for the grandchild to prove it is alive before killing anything —
// otherwise "no heartbeat" is indistinguishable from "never started".
const deadline = Date.now() + 20_000;
while (!existsSync(beat) && Date.now() < deadline) await Bun.sleep(100);
if (!existsSync(beat)) {
  console.log("INCONCLUSIVE  grandchild never wrote a heartbeat; nothing was measured");
  process.exit(3);
}
console.log("PRECONDITION  grandchild alive and beating");

if (noKill) {
  console.log("MODE          --no-kill (negative control)");
} else if (useGroup) {
  console.log("MODE          --group: kill the whole process group / tree");
  if (process.platform === "win32") {
    // Windows has no process groups in the POSIX sense; /T is the tree kill.
    const r = Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(childPid)], { stdout: "pipe", stderr: "pipe" });
    console.log(`TASKKILL      rc=${r.exitCode} ${new TextDecoder().decode(r.stdout).trim().slice(0, 160)}`);
  } else {
    try { process.kill(-childPid, "SIGKILL"); } catch (e: any) { console.log(`KILLGROUP     failed ${e.code}`); }
  }
  await Bun.sleep(500);
} else {
  console.log("MODE          naive: kill the direct child only");
  child.kill();
  if ("exited" in child) await (child as any).exited;
  await Bun.sleep(500);
}

// Let any surviving beat land, then look for movement.
const before = statSync(beat).mtimeMs;
await Bun.sleep(3000);
const after = statSync(beat).mtimeMs;

const survived = after > before;
console.log(`MTIME         before=${before} after=${after}`);
console.log(`RESULT        grandchild ${survived ? "SURVIVED" : "DIED"}`);

// Clean up whatever is left so a survivor does not leak into the next step.
try {
  if (survived) {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(childPid)]);
    } else {
      try { process.kill(-childPid, "SIGKILL"); } catch {}
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
  }
  rmSync(dir, { recursive: true, force: true });
} catch {}

// The control must survive and the real run must not. Anything else is a fail.
const expectedSurvival = noKill;
console.log(`VERDICT       ${survived === expectedSurvival ? "AS EXPECTED" : "UNEXPECTED"}`);
