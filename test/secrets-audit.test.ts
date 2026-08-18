// SPDX-License-Identifier: Apache-2.0
/**
 * The gate that makes ruling 65's "one sink" mechanical.
 *
 * Ruling 65 names the sink being bypassed as the most likely way redaction
 * fails in practice, and ruling 57 settles the shape of the answer: a rule
 * nobody enforces is a request. This is the full-tree scan, and — ruling 62b —
 * every one of its guards is exercised against a file that should trip it,
 * because a scanner that reports nothing looks exactly like a clean tree.
 *
 * It is also a scan of the REAL tree at the end, for `scripts/claims.ts`'s
 * reason: the failure class this catches lives in a file nobody touched, so a
 * check scoped to the diff cannot see it.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ALLOWED,
  BASELINE,
  isAllowed,
  ratchet,
  stripNonCode,
  unsinkedWrites,
  type BaselineEntry,
} from "../src/secrets/audit.ts";

const files = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("stripNonCode — prose about a primitive is not a call to it", () => {
  test("a line comment naming a primitive is blanked, and the line number survives", () => {
    const code = stripNonCode(`const a = 1;\n// nothing in this file calls writeFileSync\nconst b = 2;\n`);
    expect(code.split("\n")).toHaveLength(4);
    expect(code).not.toContain("writeFileSync");
    expect(code).toContain("const b = 2;");
  });

  test("a block comment naming a primitive is blanked across its lines", () => {
    const code = stripNonCode(`/**\n * a single \`writeFileSync\` of .git/config\n */\nBun.write(p, x);\n`);
    expect(code).not.toContain("writeFileSync");
    expect(code).toContain("Bun.write(p, x);");
    expect(code.split("\n")).toHaveLength(5);
  });

  test("a string body is blanked, so usage text is not a call", () => {
    const code = stripNonCode(`const USAGE = "run console.log(x) yourself";\nconsole.log(USAGE);\n`);
    expect(code.match(/console\.log/g)).toHaveLength(1);
  });

  test("a regex ending in an escaped slash does not swallow the rest of its line", () => {
    // `/^src\//` ends in `\/` followed by `/`, which a naive scanner reads as
    // the start of a line comment — and then everything after it on the line,
    // including a real call, disappears.
    const code = stripNonCode(`const seam = /^src\\//; console.log(seam);\n`);
    expect(code).toContain("console.log");
  });

  test("division is not mistaken for a regex", () => {
    const code = stripNonCode(`const ratio = total / count; console.log(ratio);\n`);
    expect(code).toContain("console.log");
  });
});

describe("unsinkedWrites — every primitive, with a file that trips it", () => {
  const trip: Array<[string, string]> = [
    ["Bun.write", `await Bun.write(path, content);`],
    ["writeFileSync", `writeFileSync(path, content);`],
    ["appendFileSync", `appendFileSync(path, line);`],
    ["writeSync", `writeSync(fd, line);`],
    ["createWriteStream", `const s = createWriteStream(path);`],
    ["writeRegularFile", `writeRegularFile(path, text);`],
    ["console", `console.log(report);`],
    ["process.stdout/stderr.write", `process.stdout.write(report);`],
  ];

  for (const [primitive, source] of trip) {
    test(`a new module calling ${primitive} is caught`, () => {
      const found = unsinkedWrites(files({ "src/report/run-report.ts": source }));
      expect(found).toHaveLength(1);
      expect(found[0]!.primitive).toBe(primitive);
      expect(found[0]!.line).toBe(1);
    });
  }

  test("NEGATIVE CONTROL: the same module going through the sink is clean", () => {
    const found = unsinkedWrites(
      files({
        "src/report/run-report.ts": `sink.write(path, JSON.stringify(record, null, 2));\nsink.outLine(report);\n`,
      }),
    );
    expect(found).toEqual([]);
  });

  test("NEGATIVE CONTROL: a doc comment describing the primitive it does not call is clean", () => {
    const found = unsinkedWrites(
      files({ "src/queue/execute.ts": `/** nothing in this file calls \`writeFileSync\`. */\nexport const x = 1;\n` }),
    );
    expect(found).toEqual([]);
  });

  test("the allowances are narrow, and each says why in terms of the bytes", () => {
    expect(isAllowed("src/secrets/sink.ts")).not.toBeNull();
    expect(isAllowed("src/isolation/safe-fs.ts")).not.toBeNull();
    expect(isAllowed("src/agent/worker.ts")).not.toBeNull();
    // NEGATIVE CONTROL: a neighbouring file in the same directory is NOT allowed.
    expect(isAllowed("src/isolation/manifest.ts")).toBeNull();
    expect(isAllowed("src/agent/drift.ts")).toBeNull();
    for (const allowance of ALLOWED) expect(allowance.why.length).toBeGreaterThan(40);
  });

  test("the allowed files really are exempt", () => {
    expect(unsinkedWrites(files({ "src/agent/worker.ts": `await Bun.write(path, content);` }))).toEqual([]);
  });

  test("`child.stdin.write` is deliberately not a primitive here", () => {
    // A stream INTO a process brigadier spawned, carrying the brief. Ruling 65
    // delivers secrets by environment injection, so the brief does not carry
    // them, and redacting a prompt would redact the one channel meant to be read.
    expect(unsinkedWrites(files({ "src/queue/spawn.ts": `child.stdin.write(line);` }))).toEqual([]);
  });

  test("files outside src/ are not scanned", () => {
    expect(unsinkedWrites(files({ "scripts/claims.ts": `console.error("claims gate FAILED");` }))).toEqual([]);
  });
});

describe("the ratchet", () => {
  const baseline: readonly BaselineEntry[] = [
    { file: "src/cli.ts", primitive: "console", count: 2, adoption: "route through the sink" },
  ];

  test("a bypass in a file the baseline never heard of is a regression", () => {
    const found = unsinkedWrites(files({ "src/report/record.ts": `writeFileSync(p, t);` }));
    expect(ratchet(found, baseline).regressions).toHaveLength(1);
    expect(ratchet(found, baseline).regressions[0]).toContain("src/report/record.ts:writeFileSync");
  });

  test("more calls than the baseline records is a regression", () => {
    const found = unsinkedWrites(files({ "src/cli.ts": `console.log(a);\nconsole.log(b);\nconsole.error(c);\n` }));
    const result = ratchet(found, baseline);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toContain("3 calls, baseline records 2");
  });

  test("NEGATIVE CONTROL: exactly the baseline is not a regression", () => {
    const found = unsinkedWrites(files({ "src/cli.ts": `console.log(a);\nconsole.error(b);\n` }));
    expect(ratchet(found, baseline).regressions).toEqual([]);
  });

  test("adoption lowers the count freely and is reported as an improvement", () => {
    const found = unsinkedWrites(files({ "src/cli.ts": `console.log(a);` }));
    const result = ratchet(found, baseline);
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toHaveLength(1);
  });

  test("every baseline row names the adoption it owes", () => {
    for (const entry of BASELINE) {
      expect(entry.count).toBeGreaterThan(0);
      expect(entry.adoption.length).toBeGreaterThan(40);
    }
  });
});

describe("the real tree, scanned in full", () => {
  const ROOT = new URL("..", import.meta.url).pathname;

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (entry.endsWith(".ts")) out.push(path);
    }
    return out;
  }

  const sources = new Map<string, string>();
  for (const file of walk(join(ROOT, "src"))) {
    sources.set(relative(ROOT, file).split("\\").join("/"), readFileSync(file, "utf8"));
  }

  test("the scan examined something — a scan of nothing is not a scan", () => {
    expect(sources.size).toBeGreaterThan(40);
    // And it found the known bypasses, so it is not silently matching nothing.
    expect(unsinkedWrites(sources).length).toBeGreaterThan(0);
  });

  test("nothing writes around the sink that the baseline does not already own", () => {
    const result = ratchet(unsinkedWrites(sources));
    expect(result.regressions).toEqual([]);
  });
});
