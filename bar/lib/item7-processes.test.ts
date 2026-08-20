// SPDX-License-Identifier: Apache-2.0
/**
 * The negative control for item 7's survivor classification.
 *
 * The guard it protects: until 2026-08-19 item 7 pushed the processes that
 * survived its own SIGKILL reap to `did` — narrative, which stamps nothing — so
 * the harness could leak a process past its own kill, print the leak, and still
 * report PASS.
 *
 * A guard that always passes looks identical to a working one, so this drives
 * BOTH directions over REAL processes rather than over invented `ProcessFacts`:
 *
 *   the POSITIVE control plants a process carrying the run marker of the run
 *   item 7 deliberately abandons, and the verdict must stay GREEN — ruling 63
 *   has `abandon` clean up nothing on purpose, and an item that failed on those
 *   would be failing the product for doing what it was told;
 *
 *   the NEGATIVE controls plant a process from the SWEPT run root and a process
 *   under no declared root at all, and the verdict must go RED, naming the pid,
 *   the class and the reason.
 *
 * Both use `survivorClasses` from the item itself. A guard tested against a
 * re-implementation of its own classes is not tested.
 *
 * Every process planted here is spawned into its own process group and the
 * GROUP is killed in `afterAll`: each fixture is a shell whose body is a
 * `sleep`, and a reaper that killed only the pids it published would leave the
 * `sleep` behind — the exact straggler class this whole module exists for.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { survivorClasses } from "../items/07-interruption-leaves-nothing.ts";
import { Checks } from "./checks.ts";
import { RUN_MARKER_FLAG } from "./inflight.ts";
import {
  classifySurvivors,
  strays,
  survivorVerdict,
  UNRECOGNISED,
  type SurvivorClass,
} from "./item7-processes.ts";
import { commandNamesDir, nameProcess, type ProcessFacts } from "./process-table.ts";

let workdir: string;
const groups: number[] = [];

/** Every fixture sleeps for this long and no longer, so a lost reap self-heals. */
const FIXTURE_SECONDS = 25;

function classesFor(scope: { swept: string[]; abandoned: string[] }): SurvivorClass[] {
  return survivorClasses({
    sweptRoot: join(workdir, "runs"),
    sweptRunIds: new Set(scope.swept),
    abandonedRoot: join(workdir, "runs-3"),
    abandonedRunIds: new Set(scope.abandoned),
    fixtureBin: join(workdir, "bin"),
    observe: join(workdir, "observe"),
  });
}

/**
 * Plant a real process whose command line is `argv`, and wait until the process
 * table actually shows it.
 *
 * Bounded: a wait with no deadline in a test is a hang wearing a test's clothes.
 */
async function plant(name: string, tail: string): Promise<number> {
  const script = join(workdir, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\nsleep ${FIXTURE_SECONDS}\n`, { mode: 0o755 });
  const proc = Bun.spawn(["/bin/sh", script, tail], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  groups.push(proc.pid);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (strays(workdir).some((row) => row.pid === proc.pid)) return proc.pid;
    await Bun.sleep(50);
  }
  return proc.pid;
}

beforeAll(() => {
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-item7-")));
});

afterAll(() => {
  for (const pid of groups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone, which is the outcome wanted.
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Same.
    }
  }
  rmSync(workdir, { recursive: true, force: true });
});

describe("a directory name ends where the directory ends", () => {
  test("`runs` does not swallow `runs-3`, in either direction", () => {
    // The collision this item would have shipped without it: a plain
    // `includes()` files every process under the ABANDONED root under the SWEPT
    // one, and fails item 7 for the product obeying ruling 63.
    expect(commandNamesDir("/tmp/w/runs-3/r/ab/1/x.sh", "/tmp/w/runs")).toBe(false);
    expect(commandNamesDir("/tmp/w/runs/r/ab/1/x.sh", "/tmp/w/runs-3")).toBe(false);
    expect(commandNamesDir("/tmp/w/runs/r/ab/1/x.sh", "/tmp/w/runs")).toBe(true);
    expect(commandNamesDir("/tmp/w/runs-3/r/ab/1/x.sh", "/tmp/w/runs-3")).toBe(true);
  });

  test("the directory itself, quoted or bare, still counts", () => {
    expect(commandNamesDir('sh -c "cd /tmp/w/runs"', "/tmp/w/runs")).toBe(true);
    expect(commandNamesDir("sh -c cd /tmp/w/runs", "/tmp/w/runs")).toBe(true);
    expect(commandNamesDir("brigadier --run-root=/tmp/w/runs --plan p", "/tmp/w/runs")).toBe(true);
    expect(commandNamesDir("sh /tmp/w/runsomething/x", "/tmp/w/runs")).toBe(false);
  });

  test("a needle bounded on the LEFT too, and terminators that are not just name characters", () => {
    // Both found by a blind critic on 2026-08-19 against the first draft, which
    // had no left boundary at all and treated every non-name character as a
    // terminator.
    expect(commandNamesDir("sh /a/w/runs/r/1", "/w/runs")).toBe(false);
    expect(commandNamesDir("sh /tmp/w/runs~3/x", "/tmp/w/runs")).toBe(false);
    expect(commandNamesDir("sh /tmp/w/runs+3/x", "/tmp/w/runs")).toBe(false);
    expect(commandNamesDir("sh /tmp/w/runs:3/x", "/tmp/w/runs")).toBe(false);
    // …and the same needle, genuinely named, still matches.
    expect(commandNamesDir("sh /tmp/w/runs/x", "/tmp/w/runs")).toBe(true);
  });
});

describe("the verdict over PLANTED, REAL processes", () => {
  test("green with nothing left behind at all", () => {
    const classes = classesFor({ swept: ["ab12"], abandoned: ["cd34"] });
    const verdict = survivorVerdict(classifySurvivors([], classes), classes);
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain("no process on this machine still named this item's workdir");
    // Auditable without the source: the classes are printed even when nothing
    // matched them.
    expect(verdict.detail).toContain(join(workdir, "runs-3"));
  });

  test("POSITIVE: a worker of the ABANDONED run is EXPECTED, and the verdict stays green", async () => {
    const pid = await plant("abandoned-worker", `${RUN_MARKER_FLAG}=cd34/1`);
    const classes = classesFor({ swept: ["ab12"], abandoned: ["cd34"] });
    const rows = classifySurvivors(strays(workdir), classes);
    const mine = rows.find((row) => row.process.pid === pid);
    expect(mine?.expected).toBe(true);
    expect(mine?.label).toContain("WORKER of the run this item ABANDONED");
    expect(survivorVerdict(rows, classes).ok).toBe(true);
  });

  test("NEGATIVE: a process from the SWEPT run root turns the verdict RED", async () => {
    const pid = await plant("swept-leak", join(workdir, "runs", "r", "ab12", "1", "escapee.sh"));
    const classes = classesFor({ swept: ["ab12"], abandoned: ["cd34"] });
    const rows = classifySurvivors(strays(workdir), classes);
    const mine = rows.find((row) => row.process.pid === pid);
    expect(mine?.expected).toBe(false);
    const verdict = survivorVerdict(rows, classes);
    expect(verdict.ok).toBe(false);
    // The reader must be able to act: which process, from which root, and why.
    expect(verdict.detail).toContain(`pid ${pid}`);
    expect(verdict.detail).toContain("the SWEPT run root");
    expect(verdict.detail).toContain("ruling 38's sweep reclaims processes always");
  });

  test("NEGATIVE: a process under NO declared root is UNRECOGNISED, and that fails too", async () => {
    const pid = await plant("mystery", join(workdir, "somewhere-nobody-declared", "thing.sh"));
    const classes = classesFor({ swept: ["ab12"], abandoned: ["cd34"] });
    const rows = classifySurvivors(strays(workdir), classes);
    const mine = rows.find((row) => row.process.pid === pid);
    expect(mine?.label).toBe(UNRECOGNISED);
    expect(mine?.expected).toBe(false);
    expect(survivorVerdict(rows, classes).ok).toBe(false);
  });
});

describe("the evidence a survivor row carries", () => {
  test("the command line is not silently clipped away, and .map cannot clip it", () => {
    // The defect this test exists for: `nameProcess` took `limit = 120`, two
    // callers said `.map(nameProcess)`, and `Array.prototype.map` passed the
    // ELEMENT INDEX as the limit — so a live item 7 run reported its reaped
    // processes as `pid 63885 (ppid 1, pgid 63057): …`. The options object is
    // what turns that into a compile error; this is the behaviour underneath it.
    const long = { pid: 7, ppid: 1, pgid: 7, commandLine: `/bin/sh ${"x".repeat(300)}` };
    expect(nameProcess(long)).toContain("xxx");
    expect(nameProcess(long).length).toBeLessThan(200);
    expect(nameProcess(long, { limit: 240 }).length).toBeGreaterThan(240);
    // A short line is never given a trailing ellipsis it did not earn.
    expect(nameProcess({ pid: 7, ppid: 1, pgid: 7, commandLine: "/bin/sleep 1" })).toBe(
      "pid 7 (ppid 1, pgid 7): /bin/sleep 1",
    );
  });
});

describe("the row item 7 actually stamps", () => {
  // `Checks.note()` stamps `ok: true`, and this repository has shipped that
  // defect once already. So the verdict is asserted through the same
  // accumulator the item uses, and the rendered row must begin `FAIL`.
  const facts = (commandLine: string): ProcessFacts => ({ pid: 4242, ppid: 1, pgid: 4242, commandLine });

  test("red renders as a FAIL row and green as an ok row", () => {
    const classes = classesFor({ swept: ["ab12"], abandoned: ["cd34"] });
    const leak = survivorVerdict(
      classifySurvivors([facts(`/bin/sh ${join(workdir, "runs", "r", "ab12", "escapee.sh")}`)], classes),
      classes,
    );
    const red = new Checks();
    red.expect(leak.name, leak.ok, leak.detail);
    expect(red.passed).toBe(false);
    expect(red.render().startsWith("FAIL ")).toBe(true);

    const clean = survivorVerdict(classifySurvivors([], classes), classes);
    const green = new Checks();
    green.expect(clean.name, clean.ok, clean.detail);
    expect(green.passed).toBe(true);
    expect(green.render().startsWith("ok  ")).toBe(true);
  });
});

describe("the classification itself", () => {
  const facts = (commandLine: string): ProcessFacts => ({ pid: 4242, ppid: 1, pgid: 4242, commandLine });

  test("a worker carrying the ABANDONED run's marker beats the bin/ shim it was launched through", () => {
    // The exact false positive this ordering exists to prevent. A real worker's
    // argv is `bun …/vendor.ts <workdir>/bin/qwen.vendor.json … --brigadier-run=<id>/1`
    // — the run root appears NOWHERE, so directories alone would file it under
    // the harness fixture and fail the item for the product being correct.
    const classes = classesFor({ swept: ["ab12"], abandoned: ["cd34"] });
    const line = `bun /x/bar/fakes/vendor.ts ${join(workdir, "bin", "qwen.vendor.json")} ${RUN_MARKER_FLAG}=cd34/1`;
    const [row] = classifySurvivors([facts(line)], classes);
    expect(row?.expected).toBe(true);
    expect(row?.alsoMatched).toContain("a harness fixture on the planted PATH (bin/)");
  });

  test("the same shape carrying the SWEPT run's marker is UNEXPECTED", () => {
    const classes = classesFor({ swept: ["ab12"], abandoned: ["cd34"] });
    const line = `bun /x/bar/fakes/vendor.ts ${join(workdir, "bin", "qwen.vendor.json")} ${RUN_MARKER_FLAG}=ab12/2`;
    const [row] = classifySurvivors([facts(line)], classes);
    expect(row?.expected).toBe(false);
    expect(row?.label).toContain("SWEPT");
  });

  test("an ABANDONED run id that was never observed cannot excuse anything", () => {
    // A stale class is the failure mode this shape is chosen to make LOUD: with
    // no run id observed under `runs-3`, the worker falls through to the `bin/`
    // fallback and fails rather than passing on a class nobody filled in.
    const classes = classesFor({ swept: [], abandoned: [] });
    const line = `bun vendor.ts ${join(workdir, "bin", "qwen.vendor.json")} ${RUN_MARKER_FLAG}=cd34/1`;
    const [row] = classifySurvivors([facts(line)], classes);
    expect(row?.expected).toBe(false);
  });

  test("NEGATIVE: an unmarked escapee UNDER THE ABANDONED ROOT is not excused", () => {
    // The critic's first line, verbatim in shape. Until 2026-08-19 the abandoned
    // class carried `paths: [abandonedRoot]` and this came back EXPECTED — the
    // escaped-descendant class ruling 38 exists for, absorbed by the one excuse
    // in the table.
    const classes = classesFor({ swept: ["ab12"], abandoned: ["cd34"] });
    const beat = join(workdir, "runs-3", "r", "cd34", "1", "beat.log");
    const line = `/bin/sh -c while true; do date >> ${beat}; sleep 0.2; done`;
    const [row] = classifySurvivors([facts(line)], classes);
    expect(row?.expected).toBe(false);
    expect(row?.label).toContain("NO marker of that run");
  });

  test("NEGATIVE: an ORCHESTRATOR still alive under the abandoned root is not excused", () => {
    // The critic's second line. Ruling 63 requires it to re-raise and DIE, so a
    // survivor here is the product failing, not the product obeying.
    const classes = classesFor({ swept: ["ab12"], abandoned: ["cd34"] });
    const line = `bun ${join(workdir, "bin", "brigadier")} run --plan p --run-root ${join(workdir, "runs-3")}`;
    const [row] = classifySurvivors([facts(line)], classes);
    expect(row?.expected).toBe(false);
  });

  test("the escapee, which carries no marker at all, is caught by its directory", () => {
    const classes = classesFor({ swept: [], abandoned: [] });
    const line = `/bin/sh ${join(workdir, "runs", "r", "ab12", "escapee-escaper.sh")}`;
    const [row] = classifySurvivors([facts(line)], classes);
    expect(row?.expected).toBe(false);
    expect(row?.label).toContain("SWEPT");
  });
});

/**
 * The citation this item makes about its own limit, checked against the file it
 * cites.
 *
 * The defect: `bar/items/07-…` excused ruling 38's one hole by citing
 * **"amendment §18"** as though §18 had granted a carve-out. §18 EXISTS — it is
 * the second measurement-amendment comment on issue #1, posted 2026-08-18 — but
 * what it does is REQUEST a ruling, closing "The gap belongs to the owner". The
 * item cited an open question for nine rounds as a settled limit. A limit that is
 * settled only in the head of the item it limits is not "in the open", which is
 * what `BAR.md`'s *When an item cannot be met* requires. The owner ruled on
 * 2026-08-20 — the ruling §18 asked for — and had it recorded in `BAR.md`; this
 * pins that it stays recorded, together with the withdrawal of this guard's own
 * earlier false claim that §18 existed nowhere.
 *
 * It is a transcription guard, and this repository's second-hardest lesson is
 * that transcriptions drift inside a single round. The negative control is the
 * whole point: the same predicate is run against a `BAR.md` with the section cut
 * out, and must say no.
 */
describe("item 7's own limit is recorded in BAR.md, not only in its head", () => {
  const ROOT = fileURLToPath(new URL("../../", import.meta.url));
  const bar = readFileSync(join(ROOT, "BAR.md"), "utf8");
  const item7 = readFileSync(join(ROOT, "bar", "items", "07-interruption-leaves-nothing.ts"), "utf8");

  /** The item-7 section of a `BAR.md` text, or `""` if it has none. */
  const itemSeven = (text: string): string => {
    const start = text.indexOf("### 7.");
    const end = text.indexOf("### 8.", start === -1 ? 0 : start);
    return start === -1 || end === -1 ? "" : text.slice(start, end);
  };

  /** Does this `BAR.md` text record the hole, as the procedure asks — which item, why, what is unproven? */
  const recordsTheHole = (text: string): boolean => {
    const section = itemSeven(text);
    return (
      section !== "" &&
      /RECORDED 2026-08-20/.test(section) &&
      /amendment §18/.test(section) &&
      /--brigadier-run=x` is not/.test(section) &&
      /promise therefore unproven/i.test(section)
    );
  };

  /**
   * Does this `BAR.md` text state the TRUE thing about §18? The block once said
   * §18 existed nowhere. It exists — on issue #1, posted 2026-08-18 — and it
   * REQUESTED a ruling rather than granting one. This pins the correction and
   * pins that the false claim stays withdrawn rather than quietly reworded.
   */
  const tellsTheTruthAboutAmendment18 = (text: string): boolean => {
    const section = itemSeven(text);
    if (section === "") return false;
    // The false claim may appear ONCE, and only inside the sentence that
    // withdraws it. A second, unquoted occurrence is the falsehood standing
    // again, which is the state this guard exists to forbid.
    const falseClaim = /no such section existed anywhere/g;
    const occurrences = section.match(falseClaim)?.length ?? 0;
    return (
      occurrences === 1 &&
      /said \*"no such section existed anywhere"\*\.?\s*\n?That claim was false and is WITHDRAWN, not reworded/.test(
        section,
      ) &&
      /CORRECTED 2026-08-20/.test(section) &&
      /\*\*§18 exists\*\*/.test(section) &&
      /issue #1, posted \*\*2026-08-18\*\*/.test(section) &&
      /granted no carve-out/.test(section) &&
      /asked for one/i.test(section) &&
      /The gap belongs to the owner/.test(section)
    );
  };

  test("the hole is written into BAR.md's item 7, with its reason and what it leaves unproven", () => {
    expect(recordsTheHole(bar)).toBe(true);
  });

  test("BAR.md says what is TRUE about §18 — it exists, and it asked for the ruling it was cited as", () => {
    expect(tellsTheTruthAboutAmendment18(bar)).toBe(true);
  });

  test("NEGATIVE CONTROL — the same predicates say no when the record is not there", () => {
    // Cut the recorded block back out and the guard must go red, or it is a
    // guard that would pass on the state it exists to forbid.
    const without = bar.replace(/\*\*RECORDED 2026-08-20[\s\S]*?\n\n/, "");
    expect(without).not.toBe(bar);
    expect(recordsTheHole(without)).toBe(false);
    // Cut only the correction and the truth predicate must go red while the
    // rest of the record still stands — the two halves are pinned separately.
    const uncorrected = bar.replace(/\*\*CORRECTED 2026-08-20[\s\S]*?\n\n/, "");
    expect(uncorrected).not.toBe(bar);
    expect(tellsTheTruthAboutAmendment18(uncorrected)).toBe(false);
    // And a section that reinstates the withdrawn falsehood must go red too.
    const relapsed = bar.replace(
      "**CORRECTED 2026-08-20",
      "no such section existed anywhere in the tree.\n\n**CORRECTED 2026-08-20",
    );
    expect(relapsed).not.toBe(bar);
    expect(tellsTheTruthAboutAmendment18(relapsed)).toBe(false);
    // And on a document with no item 7 at all.
    expect(recordsTheHole("# not the bar")).toBe(false);
    expect(tellsTheTruthAboutAmendment18("# not the bar")).toBe(false);
  });

  test("the item points the reader at BAR.md rather than at a section of its own", () => {
    // Every `amendment §N` this item cites must resolve in BAR.md. `§18` is the
    // only one. It resolved on issue #1 all along; what did not exist until
    // 2026-08-20 was the RULING it asked for, which is what this file now holds.
    const cited = [...item7.matchAll(/amendment §(\d+)/g)].map((m) => m[1]);
    expect(cited.length).toBeGreaterThan(0);
    for (const n of cited) expect(bar).toContain(`amendment §${n}`);
    // And the reader is sent to the file, in the source comment and in the row
    // the report actually prints.
    expect(item7).toContain("RECORDED IN `BAR.md`, item 7");
    expect(item7).toContain('"ruling 38\'s one hole (recorded in BAR.md, item 7 — RECORDED 2026-08-20)"');
  });
});
