// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 70: the run record is NDJSON, appended, never rewritten — and the
 * reason is a comparison, so the comparison is the test.
 *
 * The central assertion here is a NEGATIVE CONTROL in the strict sense: the same
 * facts are written twice, once as NDJSON and once as a single JSON document,
 * both are truncated at the same point, and the two are parsed. One yields every
 * fact but the last. The other yields nothing at all. Without the second half
 * the first half is just "our parser parses our format".
 *
 * The truncation is performed with `truncateSync` at a byte offset inside the
 * final line. That is exactly the file a `SIGKILL` mid-write leaves, and doing
 * it deliberately makes it a test rather than a race — but there is also a real
 * one below, which kills a real process mid-append and reads what survived.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blocks } from "../src/work/check.ts";
import {
  appendEvent,
  checkSlots,
  claimedLandings,
  dischargedItems,
  finishedIntent,
  itemsMentioned,
  openCheckSlot,
  readRunRecord,
  recordPath,
  runFacts,
  settleCheck,
  spawnedProcesses,
  type RunEvent,
} from "../src/run/record.ts";

let scratch: string;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-record-")));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function sampleEvents(): RunEvent[] {
  return [
    { type: "run-started", at: 1, runId: "r1", repo: "/repo", runRoot: "/root", pid: 42 },
    { type: "clone-recorded", at: 2, item: 1, dir: "/root/r/r1/1" },
    { type: "process-spawned", at: 3, item: 1, pid: 99, commandLine: "bun worker.ts --brigadier-run=r1/1" },
    { type: "check-slot", at: 4, item: 1, check: "verify", outcome: "not-run" },
    { type: "check-settled", at: 5, item: 1, check: "verify", outcome: "pass", detail: null },
    { type: "item-landed", at: 6, item: 1, ref: "refs/brigadier/r1/item/1", sha: "a".repeat(40) },
  ];
}

describe("one event is always one line", () => {
  test("a newline inside a field cannot split a record", () => {
    // Not a convention this hopes everyone keeps: JSON.stringify escapes it.
    const path = join(scratch, "newlines.ndjson");
    appendEvent(path, {
      type: "check-settled",
      at: 1,
      item: 1,
      check: "verify",
      outcome: "fail",
      detail: "line one\nline two\nline three",
    });
    expect(readFileSync(path, "utf8").split("\n").filter((l) => l !== "").length).toBe(1);
    const reading = readRunRecord(path);
    expect(reading.events.length).toBe(1);
    expect(reading.damagedLines).toEqual([]);
  });

  test("appending never rewrites what is already there", () => {
    const path = join(scratch, "append.ndjson");
    appendEvent(path, { type: "run-finished", at: 1, outcome: "complete" });
    const afterFirst = statSync(path).size;
    appendEvent(path, { type: "run-finished", at: 2, outcome: "abandoned" });
    expect(statSync(path).size).toBeGreaterThan(afterFirst);
    // The first line is byte-identical to what it was.
    expect(readFileSync(path, "utf8").startsWith(`${JSON.stringify({ type: "run-finished", at: 1, outcome: "complete" })}\n`)).toBe(true);
  });

  test("it refuses to append through a symlink", () => {
    const target = join(scratch, "elsewhere.json");
    writeFileSync(target, "");
    const link = join(scratch, "record-link.ndjson");
    symlinkSync(target, link);
    expect(() => appendEvent(link, { type: "run-finished", at: 1, outcome: "complete" })).toThrow(/symlink/);
  });
});

describe("a truncated record is still evidence — and a JSON document is not", () => {
  const facts = sampleEvents();

  test("NDJSON cut inside its last line keeps every earlier fact", () => {
    const path = join(scratch, "truncated.ndjson");
    for (const event of facts) appendEvent(path, event);
    const full = statSync(path).size;
    const lastLineLength = `${JSON.stringify(facts[facts.length - 1]!)}\n`.length;
    // Cut halfway through the final line: the file a kill leaves behind.
    truncateSync(path, full - Math.floor(lastLineLength / 2));

    const reading = readRunRecord(path);
    expect(reading.events.length).toBe(facts.length - 1);
    expect(reading.truncatedTail).not.toBeNull();
    expect(reading.damagedLines).toEqual([]);
    // And the surviving facts are usable, not just countable.
    expect(runFacts(reading.events)?.runId).toBe("r1");
    expect(spawnedProcesses(reading.events)[0]?.pid).toBe(99);
    expect(itemsMentioned(reading.events)).toEqual([1]);
  });

  test("NEGATIVE CONTROL: the same facts as one JSON document yield nothing", () => {
    // This is why ruling 70 is a ruling. A single document truncated by a kill
    // is unparseable IN ITS ENTIRETY: every earlier fact is lost with the last.
    const path = join(scratch, "truncated.json");
    const document = JSON.stringify({ events: facts }, null, 2);
    writeFileSync(path, document);
    truncateSync(path, Math.floor(document.length * 0.85));

    let recovered: unknown = "parsed";
    let threw = false;
    try {
      recovered = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(recovered).toBe("parsed");
    // Nothing at all survives: no run id, no pid, no landing.
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(0);
  });

  test("an append after a truncated tail does not fuse with it", () => {
    // Resumption is the case this format exists for, so it is the case that must
    // not lose anything extra. Appending straight onto a fragment left by a kill
    // produced `{"type":"run-star{"type":"run-finished"...}` — one line, one
    // damaged-line report, and the NEW event lost as well as the old one.
    const path = join(scratch, "resume-append.ndjson");
    for (const event of facts) appendEvent(path, event);
    truncateSync(path, statSync(path).size - 30);
    const beforeResume = readRunRecord(path);
    expect(beforeResume.truncatedTail).not.toBeNull();

    appendEvent(path, { type: "run-finished", at: 99, outcome: "abandoned" });

    const reading = readRunRecord(path);
    // The fragment is still reported, and it costs exactly itself.
    expect(reading.damagedLines.length).toBe(1);
    expect(reading.truncatedTail).toBeNull();
    // The resumed event survived whole, which is the part that used to be lost.
    expect(finishedIntent(reading.events)).toBe("abandoned");
    expect(reading.events.length).toBe(beforeResume.events.length + 1);
  });

  test("a damaged line in the MIDDLE is reported separately from a truncated tail", () => {
    // A kill truncates the end. Anything else is a different problem, and a
    // reader that treated them alike would hide it.
    const path = join(scratch, "damaged.ndjson");
    writeFileSync(
      path,
      `${JSON.stringify(facts[0]!)}\n{"type":"clone-recorded","at":\n${JSON.stringify(facts[5]!)}\n`,
    );
    const reading = readRunRecord(path);
    expect(reading.events.length).toBe(2);
    expect(reading.damagedLines).toEqual([2]);
    expect(reading.truncatedTail).toBeNull();
  });

  test("an event missing a required field is not folded as if it were whole", () => {
    const path = join(scratch, "partial-fields.ndjson");
    writeFileSync(path, `{"type":"item-landed","at":1,"item":1}\n`);
    const reading = readRunRecord(path);
    expect(reading.events).toEqual([]);
    expect(reading.damagedLines).toEqual([1]);
  });

  test("a record that does not exist reads as empty rather than throwing", () => {
    const reading = readRunRecord(join(scratch, "nothing-here.ndjson"));
    expect(reading.events).toEqual([]);
    expect(reading.lines).toBe(0);
  });
});

describe("ruling 52's write-ahead: absence is made impossible", () => {
  test("the slot exists, holding a BLOCKING value, before the check runs", () => {
    const path = join(scratch, "slots.ndjson");
    openCheckSlot(path, 1, "verify", 10);
    // The crash happens HERE — between started and finished. Nothing else is
    // written, and the record is read exactly as a later resume would read it.
    const slots = checkSlots(readRunRecord(path).events);
    expect(slots.length).toBe(1);
    expect(slots[0]?.outcome).toBe("not-run");
    expect(slots[0]?.settled).toBe(false);
    // v1's bug: the killed gate decayed into an ordinary skip and the slice
    // committed. `not-run` blocks.
    expect(blocks(slots[0]!.outcome)).toBe(true);
  });

  test("settling the check replaces the value and marks it settled", () => {
    const path = join(scratch, "settled.ndjson");
    openCheckSlot(path, 2, "review", 10);
    settleCheck(path, 2, "review", "pass", "codex approved", 20);
    const slots = checkSlots(readRunRecord(path).events);
    expect(slots[0]?.outcome).toBe("pass");
    expect(slots[0]?.settled).toBe(true);
    expect(blocks(slots[0]!.outcome)).toBe(false);
  });

  test("NEGATIVE CONTROL: a record with no slot at all reports no check, not a pass", () => {
    // The failure this guards is a reader that treats "no slot" as "nothing to
    // worry about". There is no such value in the fold: a check that was never
    // opened simply is not there, and a caller counting expected checks sees
    // one missing rather than one passing.
    const path = join(scratch, "no-slots.ndjson");
    appendEvent(path, { type: "run-started", at: 1, runId: "r1", repo: "/r", runRoot: "/x", pid: 1 });
    expect(checkSlots(readRunRecord(path).events)).toEqual([]);
  });

  test("a truncated record loses the RESULT and keeps the blocking slot", () => {
    // The exact composition ruling 70 claims: the write-ahead survives the
    // crash because it was a separate line.
    const path = join(scratch, "slot-truncated.ndjson");
    openCheckSlot(path, 3, "verify", 10);
    settleCheck(path, 3, "verify", "pass", null, 20);
    truncateSync(path, statSync(path).size - 20);
    const slots = checkSlots(readRunRecord(path).events);
    expect(slots[0]?.outcome).toBe("not-run");
    expect(blocks(slots[0]!.outcome)).toBe(true);
  });
});

describe("the record is intent, and says so", () => {
  test("landings, discharges and the finish are all readable as claims", () => {
    const path = join(scratch, "intent.ndjson");
    for (const event of sampleEvents()) appendEvent(path, event);
    appendEvent(path, { type: "run-finished", at: 7, outcome: "complete" });
    appendEvent(path, { type: "discharged", at: 8, item: 1, by: "operator" });
    const events = readRunRecord(path).events;
    expect(claimedLandings(events).get(1)?.ref).toBe("refs/brigadier/r1/item/1");
    expect(finishedIntent(events)).toBe("complete");
    expect(dischargedItems(events).items.has(1)).toBe(true);
    expect(dischargedItems(events).run).toBe(false);
  });

  test("a `running` field planted by someone else is not surfaced by any fold", async () => {
    // Ruling 63/58: a state file records intent, the world records fact. The
    // earlier version of this test grepped a file it had just written itself,
    // which could not fail. This plants the field a hostile or older writer
    // would leave and asserts the READER never hands it to anybody: the event
    // still parses (extra fields are tolerated, so a record from a newer
    // brigadier is still evidence) and no fold exposes a liveness verdict.
    const path = join(scratch, "planted-running.ndjson");
    writeFileSync(
      path,
      `{"type":"run-started","at":1,"runId":"r1","repo":"/r","runRoot":"/x","pid":4242,"running":true}\n` +
        `{"type":"check-slot","at":2,"item":1,"check":"verify","outcome":"not-run","running":true}\n`,
    );
    const reading = readRunRecord(path);
    expect(reading.damagedLines).toEqual([]);
    expect(reading.events.length).toBe(2);

    const facts = runFacts(reading.events);
    expect(facts).not.toBeNull();
    expect(Object.keys(facts!)).toEqual(["runId", "repo", "runRoot", "startedAt", "pid"]);
    for (const slot of checkSlots(reading.events)) {
      expect(Object.keys(slot).sort()).toEqual(["check", "detail", "item", "outcome", "settled"]);
    }
    // The module exports nothing that answers "is this run alive". That question
    // is `sweep.ts`'s, and its answer comes from the process table.
    expect(Object.keys(await import("../src/run/record.ts"))).not.toContain("isRunning");
  });

  test("recordPath sits beside the manifest in the run directory", () => {
    expect(recordPath("/root", "r1")).toBe(join("/root", "r", "r1", "record.ndjson"));
  });
});

describe("a real process killed mid-run leaves a readable record", () => {
  test("SIGKILL during appends loses at most the last line", async () => {
    const path = join(scratch, "live-kill.ndjson");
    const script = join(scratch, "appender.ts");
    writeFileSync(
      script,
      [
        "// SPDX-License-Identifier: Apache-2.0",
        `import { appendEvent } from ${JSON.stringify(join(import.meta.dir, "..", "src", "run", "record.ts"))};`,
        `const path = ${JSON.stringify(path)};`,
        "let n = 0;",
        "setInterval(() => { appendEvent(path, { type: 'process-spawned', at: Date.now(), item: 1, pid: ++n, commandLine: 'x'.repeat(400) }); }, 2);",
      ].join("\n"),
    );
    const child = Bun.spawn(["bun", script], { stdout: "ignore", stderr: "pipe" });
    await Bun.sleep(600);
    child.kill("SIGKILL");
    await child.exited;

    const reading = readRunRecord(path);
    // Real work happened: this is not a test of an empty file.
    expect(reading.events.length).toBeGreaterThan(10);
    expect(reading.damagedLines).toEqual([]);
    // Every surviving event is a whole event, and the pids are the unbroken
    // sequence the child wrote — nothing in the middle was lost.
    const pids = spawnedProcesses(reading.events).map((p) => p.pid);
    expect(pids).toEqual(pids.map((_, index) => index + 1));
  }, 20_000);
});
