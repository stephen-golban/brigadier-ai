/**
 * Probe — ticket #43. Can a descendant break OUT of the containment that
 * decisions 5 and 15 rest on, and what closes it if it does?
 *
 * Ticket #5 measured the *ordinary* case: an ordinary grandchild dies with the
 * job on Windows and leaks on POSIX unless you spawn detached and kill the
 * group. That is the cooperative descendant. This probe measures the
 * adversarial one — a descendant created by a route that deliberately or
 * incidentally leaves the container:
 *
 *   POSIX    a grandchild spawned `detached: true`, which calls setsid() and so
 *            leaves the process group `kill(-pgid)` addresses. This is v1's
 *            recorded escape, reproduced.
 *   Windows  CREATE_BREAKAWAY_FROM_JOB; a process created by the WMI service;
 *            one created by the Task Scheduler service; `cmd /c start`.
 *            The first three are launched by a *different* process than ours,
 *            which is the whole point — a job contains descendants, not
 *            requests to a service that has its own.
 *
 * It also reads the job's LimitFlags directly (`job-inspect.ps1 -Mode flags`)
 * rather than inferring them, because "the escape failed" and "Bun forbids
 * breakaway" are different claims and only one of them is evidence.
 *
 * Every scenario carries a stated expectation and the run prints AS EXPECTED /
 * UNEXPECTED per row. `plain` is the negative control on both platforms: it
 * must DIE, and if it does not then containment is broken outright and no other
 * row on that platform means anything.
 *
 * Finally, for any descendant that did escape, the probe runs the marker sweep
 * decision 15 already specifies for runs that died without cleaning up, and
 * reports whether the sweep actually reclaims it.
 *
 * Usage:
 *   bun breakaway.ts                 run every scenario applicable to this platform
 *   bun breakaway.ts --only <name>   run one
 *   bun breakaway.ts --list          print the scenario table and exit
 */

import { mkdirSync, existsSync, statSync, rmSync, readFileSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const argv = Bun.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? "");
};
const only = flag("only");
const listOnly = argv.includes("--list");

const isWin = process.platform === "win32";
const here = dirname(fileURLToPath(import.meta.url));
const ps1 = join(here, "job-inspect.ps1");

type Expectation = "SURVIVED" | "DIED";

type Scenario = {
  name: string;
  platforms: NodeJS.Platform[];
  expect: Expectation;
  why: string;
};

// `expect` is what the mechanism *should* do if the containment story in
// decisions 5 and 15 is accurate. A row that comes back UNEXPECTED is the
// finding, in either direction.
const SCENARIOS: Scenario[] = [
  {
    name: "plain",
    platforms: ["darwin", "linux", "win32"],
    expect: "DIED",
    why: "negative control — the ordinary grandchild #5 already measured; if this survives, containment is broken and nothing below is interpretable",
  },
  {
    name: "posix-detached",
    platforms: ["darwin", "linux"],
    expect: "SURVIVED",
    why: "grandchild calls setsid() via spawn(detached), leaving the process group kill(-pgid) addresses — v1's recorded escape",
  },
  {
    name: "win-cmd-start",
    platforms: ["win32"],
    expect: "DIED",
    why: "`cmd /c start` creates a new console but is still a descendant, so the job should still hold it",
  },
  {
    name: "win-breakaway",
    platforms: ["win32"],
    expect: "DIED",
    why: "CREATE_BREAKAWAY_FROM_JOB is refused unless the job sets JOB_OBJECT_LIMIT_BREAKAWAY_OK — the flags read tells us which",
  },
  {
    name: "win-wmi",
    platforms: ["win32"],
    expect: "SURVIVED",
    why: "Win32_Process.Create is executed by the WMI service, so the new process is a descendant of WmiPrvSE and never enters our job",
  },
  {
    name: "win-schtasks",
    platforms: ["win32"],
    expect: "SURVIVED",
    why: "the Task Scheduler service launches the process, same reasoning as WMI",
  },
];

if (listOnly) {
  for (const s of SCENARIOS) {
    console.log(`${s.name.padEnd(16)} ${s.platforms.join(",").padEnd(20)} expect=${s.expect.padEnd(9)} ${s.why}`);
  }
  process.exit(0);
}

const applicable = SCENARIOS.filter(
  (s) => s.platforms.includes(process.platform) && (!only || s.name === only),
);
const skipped = SCENARIOS.filter((s) => !s.platforms.includes(process.platform));

const root = join(tmpdir(), `brig-breakaway-${process.pid}`);
mkdirSync(root, { recursive: true });

// --------------------------------------------------------------- the payloads
// The grandchild takes its heartbeat path and its marker from argv, so the
// marker is visible in the process's own command line and the sweep has
// something real to match on.
const grandchildSrc = join(root, "grandchild.ts");
await Bun.write(
  grandchildSrc,
  `const beat = Bun.argv[2];
let n = 0;
setInterval(async () => { await Bun.write(beat, String(++n)); }, 250);
setTimeout(() => process.exit(0), 120_000);
`,
);

// One child, many launch methods, chosen at runtime. Writing six near-identical
// child scripts would make the differences hard to see, which is the opposite
// of what this probe is for.
const childSrc = join(root, "child.ts");
await Bun.write(
  childSrc,
  `import { spawn as nodeSpawn } from "node:child_process";
const [method, bun, gc, beat, marker, ps1, outDir] = Bun.argv.slice(2);
const q = (s) => '"' + s + '"';
const note = (s) => Bun.write(outDir + "/child.log", s + "\\n");

try {
  switch (method) {
    case "plain":
      Bun.spawn([bun, gc, beat, marker], { stdio: ["ignore", "ignore", "ignore"] });
      break;

    case "posix-detached":
      // detached: true calls setsid(), giving the grandchild its own session
      // and process group. kill(-pgid) against OUR group will not reach it.
      nodeSpawn(bun, [gc, beat, marker], { detached: true, stdio: "ignore" }).unref();
      break;

    case "win-cmd-start":
      Bun.spawn(["cmd", "/c", "start", "/b", "", bun, gc, beat, marker], { stdio: ["ignore", "ignore", "ignore"] });
      break;

    case "win-breakaway": {
      // powershell is itself inside our job, so its CreateProcess call is the
      // genuine in-job breakaway attempt. Its KEY=VALUE output is the evidence.
      const r = Bun.spawnSync([
        "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1,
        "-Mode", "breakaway", "-Exe", bun,
        "-Arguments", q(gc) + " " + q(beat) + " " + marker,
      ], { stdout: "pipe", stderr: "pipe" });
      await Bun.write(outDir + "/breakaway.out",
        new TextDecoder().decode(r.stdout) + "\\n--- stderr ---\\n" + new TextDecoder().decode(r.stderr));
      break;
    }

    case "win-wmi": {
      const cmd = q(bun) + " " + q(gc) + " " + q(beat) + " " + marker;
      const r = Bun.spawnSync([
        "powershell", "-NoProfile", "-Command",
        "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='" +
          cmd.replace(/'/g, "''") + "'}; " +
        "Write-Output ('WMI_RETURN=' + $r.ReturnValue); Write-Output ('WMI_PID=' + $r.ProcessId)",
      ], { stdout: "pipe", stderr: "pipe" });
      await Bun.write(outDir + "/wmi.out",
        new TextDecoder().decode(r.stdout) + "\\n--- stderr ---\\n" + new TextDecoder().decode(r.stderr));
      break;
    }

    case "win-schtasks": {
      const task = "brig43_" + marker;
      const tr = q(bun) + " " + q(gc) + " " + q(beat) + " " + marker;
      const create = Bun.spawnSync(["schtasks", "/create", "/tn", task, "/tr", tr, "/sc", "once", "/st", "23:59", "/f"], { stdout: "pipe", stderr: "pipe" });
      const run = Bun.spawnSync(["schtasks", "/run", "/tn", task], { stdout: "pipe", stderr: "pipe" });
      await Bun.write(outDir + "/schtasks.out",
        "CREATE_RC=" + create.exitCode + "\\n" + new TextDecoder().decode(create.stdout) +
        "\\nRUN_RC=" + run.exitCode + "\\n" + new TextDecoder().decode(run.stdout) +
        "\\n--- stderr ---\\n" + new TextDecoder().decode(create.stderr) + new TextDecoder().decode(run.stderr));
      await Bun.write(outDir + "/schtasks.name", task);
      break;
    }

    default:
      note("unknown method " + method);
  }
} catch (e) {
  note("threw: " + String(e && e.message));
}

setTimeout(() => process.exit(0), 120_000);
`,
);

// ------------------------------------------------------------ the job flags
// Read the limit flags of the job Bun puts its children in. This runs as a
// Bun-spawned child precisely so it reports Bun's job and not the shell's.
const readJobFlags = async (): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  if (!isWin) return out;
  const r = Bun.spawnSync(
    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Mode", "flags"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const text = new TextDecoder().decode(r.stdout);
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  if (r.exitCode !== 0) out.PS_EXIT = String(r.exitCode);
  const err = new TextDecoder().decode(r.stderr).trim();
  if (err) out.PS_STDERR = err.slice(0, 400);
  return out;
};

// ------------------------------------------------------------------ the sweep
// Decision 15 already specifies a reclamation sweep for runs that died without
// cleaning up. This is that sweep, matching on a marker brigadier itself wrote
// into the process's command line — never on a name pattern, which the map
// records as matching the harness itself.
const findByMarker = (marker: string): number[] => {
  const pids: number[] = [];
  if (isWin) {
    const r = Bun.spawnSync([
      "powershell", "-NoProfile", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`,
    ], { stdout: "pipe", stderr: "pipe" });
    for (const line of new TextDecoder().decode(r.stdout).split(/\r?\n/)) {
      const n = Number(line.trim());
      if (Number.isFinite(n) && n > 0 && n !== process.pid) pids.push(n);
    }
  } else {
    const r = Bun.spawnSync(["ps", "-Ao", "pid=,args="], { stdout: "pipe", stderr: "pipe" });
    for (const line of new TextDecoder().decode(r.stdout).split("\n")) {
      if (!line.includes(marker)) continue;
      const n = Number(line.trim().split(/\s+/)[0]);
      if (Number.isFinite(n) && n > 0 && n !== process.pid) pids.push(n);
    }
  }
  return pids;
};

const killPid = (pid: number) => {
  if (isWin) Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(pid)], { stdout: "pipe", stderr: "pipe" });
  else { try { process.kill(pid, "SIGKILL"); } catch {} }
};

// ------------------------------------------------------------------- one run
type Row = {
  scenario: string;
  expect: Expectation;
  observed: Expectation | "INCONCLUSIVE";
  verdict: string;
  sweep: string;
  detail: string;
};

const runScenario = async (s: Scenario): Promise<Row> => {
  const marker = `brig43x${process.pid}x${s.name.replace(/[^a-z0-9]/gi, "")}`;
  const dir = join(root, s.name);
  mkdirSync(dir, { recursive: true });
  const beat = join(dir, "heartbeat.txt");

  const childArgs = [childSrc, s.name, process.execPath, grandchildSrc, beat, marker, ps1, dir];

  // The containment shape differs by platform and that difference IS decision
  // 5's measured correction: Windows gets a job for free, POSIX needs an
  // explicit detached spawn so there is a group to address.
  const child = isWin
    ? Bun.spawn([process.execPath, ...childArgs], { stdio: ["ignore", "ignore", "ignore"] })
    : nodeSpawn(process.execPath, childArgs, { detached: true, stdio: "ignore" });
  const childPid = child.pid!;

  // Precondition: never interpret "no heartbeat" as "died". It is far more
  // often "never started", and the two are opposite findings.
  const deadline = Date.now() + 45_000;
  while (!existsSync(beat) && Date.now() < deadline) await Bun.sleep(150);

  // Generous, because the KEY=VALUE evidence from the helper is the finding on
  // the breakaway row and a 300-char slice cut it off before the return codes.
  const detailFiles = ["breakaway.out", "wmi.out", "schtasks.out", "child.log"]
    .filter((f) => existsSync(join(dir, f)))
    .map((f) => `${f}: ${readFileSync(join(dir, f), "utf8").replace(/\s+/g, " ").trim().slice(0, 1500)}`)
    .join(" | ");

  if (!existsSync(beat)) {
    killPid(childPid);
    for (const p of findByMarker(marker)) killPid(p);
    return {
      scenario: s.name, expect: s.expect, observed: "INCONCLUSIVE",
      verdict: "INCONCLUSIVE", sweep: "n/a",
      detail: `grandchild never wrote a heartbeat — nothing was measured. ${detailFiles}`,
    };
  }

  // Containment.
  if (isWin) {
    (child as ReturnType<typeof Bun.spawn>).kill();
    await (child as ReturnType<typeof Bun.spawn>).exited;
  } else {
    try { process.kill(-childPid, "SIGKILL"); } catch { /* group already gone */ }
  }
  await Bun.sleep(800);

  const before = statSync(beat).mtimeMs;
  await Bun.sleep(3000);
  const after = statSync(beat).mtimeMs;
  const observed: Expectation = after > before ? "SURVIVED" : "DIED";

  // Only meaningful when something actually survived; a sweep that finds
  // nothing because nothing escaped is not evidence the sweep works.
  let sweep = "not applicable — nothing survived";
  if (observed === "SURVIVED") {
    const found = findByMarker(marker);
    for (const p of found) killPid(p);
    await Bun.sleep(1200);
    const t0 = statSync(beat).mtimeMs;
    await Bun.sleep(2500);
    const stillBeating = statSync(beat).mtimeMs > t0;
    sweep = `found ${found.length} pid(s) by marker; after kill still beating=${stillBeating}`;
  }

  // Never leave a survivor behind for the next scenario to trip over.
  killPid(childPid);
  if (!isWin) { try { process.kill(-childPid, "SIGKILL"); } catch {} }
  for (const p of findByMarker(marker)) killPid(p);
  if (isWin && existsSync(join(dir, "schtasks.name"))) {
    const task = readFileSync(join(dir, "schtasks.name"), "utf8").trim();
    Bun.spawnSync(["schtasks", "/delete", "/tn", task, "/f"], { stdout: "pipe", stderr: "pipe" });
  }

  return {
    scenario: s.name, expect: s.expect, observed,
    verdict: observed === s.expect ? "AS EXPECTED" : "UNEXPECTED",
    sweep, detail: detailFiles,
  };
};

// ---------------------------------------------------------------------- main
console.log(`PLATFORM      ${process.platform} ${process.arch}  bun=${Bun.version}`);

if (isWin) {
  const flags = await readJobFlags();
  console.log("JOB FLAGS     (of the job Bun places a spawned child in)");
  for (const [k, v] of Object.entries(flags)) console.log(`  ${k}=${v}`);
  if (flags.FLAG_JOB_OBJECT_LIMIT_BREAKAWAY_OK !== undefined) {
    console.log(
      `  => breakaway is ${flags.FLAG_JOB_OBJECT_LIMIT_BREAKAWAY_OK === "True" ? "PERMITTED by the job" : "FORBIDDEN by the job"}`,
    );
  }
  console.log("");
} else {
  console.log("JOB FLAGS     SKIPPED — Windows only. A skipped check is not a passing one.\n");
}

const rows: Row[] = [];
for (const s of applicable) {
  console.log(`RUN           ${s.name} — expect ${s.expect}`);
  rows.push(await runScenario(s));
}

console.log("\n--- results ---");
for (const r of rows) {
  console.log(`${r.scenario.padEnd(16)} expect=${r.expect.padEnd(9)} observed=${String(r.observed).padEnd(12)} ${r.verdict}`);
  if (r.sweep !== "not applicable — nothing survived") console.log(`${"".padEnd(16)} sweep: ${r.sweep}`);
  if (r.detail) console.log(`${"".padEnd(16)} detail: ${r.detail}`);
}

if (skipped.length) {
  console.log("\n--- skipped on this platform (NOT passes) ---");
  for (const s of skipped) console.log(`${s.name.padEnd(16)} needs ${s.platforms.join("/")}`);
}

const control = rows.find((r) => r.scenario === "plain");
if (control && control.observed !== "DIED") {
  console.log("\n!! CONTROL FAILED — the ordinary grandchild survived containment. Every other row here is uninterpretable.");
}

rmSync(root, { recursive: true, force: true });

const unexpected = rows.filter((r) => r.verdict !== "AS EXPECTED");
console.log(`\nSUMMARY       ${rows.length} scenario(s) run, ${unexpected.length} not as expected, ${skipped.length} skipped`);
