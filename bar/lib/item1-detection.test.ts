// SPDX-License-Identifier: Apache-2.0
/**
 * Item 1's early-exit path, driven through the item's own `run`.
 *
 * Until 2026-08-19 item 1 had one path — `brigadier agents` yielded no
 * plantable profile row — that returned a bare `BarResult` literal instead of
 * going through `combine`. It was the ONLY such return in any of the thirteen
 * items, so it was the only result the reporting layer could not describe the
 * way it describes every other one: no `halves`, and therefore no way for a
 * reader to see whether the credential-free half or the live half had decided.
 *
 * A guard on that is worthless unless it REACHES the path, so nothing here is
 * asserted against a hand-built object. Item 1's real `run` is driven three
 * times against three different stand-in binaries, and the arms differ in ONE
 * thing: what `brigadier agents` prints.
 *
 *   A. a table whose every profile is bridged through `npx`  → early exit
 *   B. `agents` prints nothing at all                        → early exit
 *   C. a table naming one plantable profile                  → past the early
 *      exit, into the ordinary `combine` at the bottom of the item
 *
 * Arm C is the control, and it is not decoration. Without it, A and B could be
 * passing because item 1 returns that shape on EVERY path — including a broken
 * rewrite that never reaches the branch at all — and a guard that always passes
 * looks identical to a working one. C proves the fixture difference is what
 * routes the item, and it supplies a REAL result from a REAL other path to
 * compare shapes against, rather than an expectation typed out here.
 *
 * THE HONEST LIMIT, stated rather than papered over: the binary is a stand-in,
 * not the compiled artifact. The compiled `brigadier` prints a real profile
 * table, and there is no argv, environment or filesystem state that makes it
 * print an unplantable one — reaching this branch against the real binary would
 * mean breaking the product first. Everything downstream of the process
 * boundary is the real code path: the real `exec`, the real `parseAgentsTable`,
 * the real `plantableAgent`, the real `combine`. What is substituted is the
 * bytes on the far side of a pipe, which is exactly what this branch reads.
 *
 * MEASURED against `bun 1.3.14` on darwin 25.5.0 on 2026-08-20.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ITEM_1, { parseAgentsTable, plantableAgent } from "../items/01-detection-is-honest.ts";
import type { BarContext, BarResult, RunOptions } from "../types.ts";
import { ensureDir, removeDir, writeScript } from "./fs.ts";
import { baseEnv, exec } from "./proc.ts";

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-item1-")));
afterAll(() => {
  removeDir(SCRATCH);
});

/** Every profile bridged through `npx`, which cannot be planted at a path. */
const BRIDGED_ONLY = [
  "claude — Claude Code",
  "  command    npx -y @agentclientprotocol/claude-agent-acp",
  "  measured   0.69.0 (claude 2.1.233)",
  "gemini — Gemini CLI",
  "  command    npx -y @google/gemini-cli --experimental-acp",
  "  measured   0.55.1",
].join("\n");

/** The same table with one profile that IS its own binary. */
const WITH_PLANTABLE = [
  "claude — Claude Code",
  "  command    npx -y @agentclientprotocol/claude-agent-acp",
  "  measured   0.69.0 (claude 2.1.233)",
  "qwen — Qwen Code",
  "  command    qwen --acp",
  "  measured   0.21.13",
].join("\n");

/**
 * A stand-in `brigadier` that answers `agents` with `table` and nothing else.
 *
 * Written as a wrapper around this process's own interpreter rather than as a
 * shell script that echoes: the items drive `detect` with a deliberately empty
 * `PATH`, so a fixture that needed anything looked up on `PATH` would fail for
 * a reason that has nothing to do with what is under test.
 */
function stubBinary(dir: string, table: string): string {
  const stub = join(dir, "agents-stub.mjs");
  writeFileSync(
    stub,
    [
      "const args = process.argv.slice(2);",
      `if (args[0] === "agents") { process.stdout.write(${JSON.stringify(table)}); process.exit(0); }`,
      'process.stderr.write("this stand-in implements only `agents`\\n");',
      "process.exit(3);",
      "",
    ].join("\n"),
  );
  const quote = (value: string): string => `"${value.split('"').join('\\"')}"`;
  return writeScript(
    join(dir, "brigadier"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(stub)} "$@"\n`,
    `@echo off\r\n${quote(process.execPath)} ${quote(stub)} %*\r\n`,
  );
}

/** Item 1's own `run`, over the same `BarContext` shape `bar/run.ts` builds. */
async function driveItem1(name: string, table: string): Promise<BarResult> {
  const root = ensureDir(join(SCRATCH, name));
  const workdir = ensureDir(join(root, "work"));
  const binary = stubBinary(ensureDir(join(root, "bin")), table);
  const ctx: BarContext = {
    binary,
    live: false,
    workdir,
    run: (args: string[], opts: RunOptions = {}) =>
      exec([binary, ...args], {
        cwd: opts.cwd ?? workdir,
        env: opts.env ?? baseEnv(),
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
        timeoutMs: opts.timeoutMs ?? 30_000,
      }),
    log: () => {},
  };
  return ITEM_1.run(ctx);
}

describe("the fixtures really do decide which branch item 1 takes", () => {
  // Asserted, not assumed. If `plantableAgent` is ever relaxed, the two
  // early-exit arms below would stop reaching the path they exist to reach and
  // would go on passing on whatever they did reach.
  test("the bridged-only table names nothing plantable, and the other one does", () => {
    expect(plantableAgent(parseAgentsTable(BRIDGED_ONLY))).toBeUndefined();
    expect(plantableAgent(parseAgentsTable(""))).toBeUndefined();
    expect(plantableAgent(parseAgentsTable(WITH_PLANTABLE))?.id).toBe("qwen");
  });
});

/**
 * Each arm driven once, whichever test asks for it first.
 *
 * Memoised rather than run in a `beforeAll`, so no test depends on another
 * having already assigned a variable — an ordering a reader cannot see is an
 * ordering that breaks silently.
 */
const ARMS = new Map<string, Promise<BarResult>>();
function arm(name: string, table: string): Promise<BarResult> {
  const existing = ARMS.get(name);
  if (existing !== undefined) return existing;
  const started = driveItem1(name, table);
  ARMS.set(name, started);
  return started;
}
const bridgedArm = (): Promise<BarResult> => arm("bridged-only", BRIDGED_ONLY);
const silentArm = (): Promise<BarResult> => arm("silent-agents", "");
const normalArm = (): Promise<BarResult> => arm("with-plantable", WITH_PLANTABLE);
const ARM_BUDGET_MS = 180_000;

describe("item 1's early exit reports its provenance like every other path", () => {
  test(
    "ARM C — the control: a plantable row routes PAST the early exit",
    async () => {
      // The stand-in implements no `detect`, so this arm fails on the ordinary
      // judgement. What matters is WHICH failure it is: the detection
      // assertions ran and the premise row is nowhere, which is only true if
      // the fixture difference — and nothing else — is what sends A and B down
      // the branch under test.
      const normal = await normalArm();
      expect(normal.observed).toContain("renamed off PATH reports absent");
      expect(normal.reason ?? "").not.toContain("no ground truth to plant against");
      expect(normal.halves).toBeDefined();
    },
    ARM_BUDGET_MS,
  );

  for (const [label, drive] of [
    ["A (every profile bridged through npx)", bridgedArm],
    ["B (`agents` printed nothing at all)", silentArm],
  ] as const) {
    test(
      `ARM ${label} — the outcome is still FAIL`,
      async () => {
        expect((await drive()).outcome).toBe("FAIL");
      },
      ARM_BUDGET_MS,
    );

    test(
      `ARM ${label} — halves name the CREDENTIAL-FREE half as the one that failed`,
      async () => {
        // The failure happens before any vendor is driven, so it belongs to
        // the half a bare CI machine grades. `live` is the vacuous PASS that
        // `LiveHalf.none` produces — item 1 has no live half, on this path or
        // any other — and it is IDENTICAL to what the ordinary path reports,
        // which is the point.
        const early = await drive();
        expect(early.halves).toBeDefined();
        expect(early.halves?.credentialFree).toBe("FAIL");
        expect(early.halves?.live).toBe("PASS");
        expect(early.halves?.live).toBe((await normalArm()).halves?.live);
      },
      ARM_BUDGET_MS,
    );

    test(
      `ARM ${label} — it never claims a credential was the missing ingredient`,
      async () => {
        const early = await drive();
        expect(early.outcome).not.toBe("SKIPPED");
        expect(early.observed).toContain("this item has no live half");
        expect(early.reason ?? "").not.toMatch(/skipped|requires real vendor|credential/i);
      },
      ARM_BUDGET_MS,
    );

    test(
      `ARM ${label} — the reason still says what it said before`,
      async () => {
        const early = await drive();
        expect(early.reason ?? "").toContain(
          "could not read a plantable agent out of `brigadier agents`, so the item has no ground truth to plant against",
        );
        // And it still carries the bytes it saw, which is what a reader
        // re-derives the verdict from.
        expect(early.observed).toContain("`brigadier agents` exit");
        expect(early.observed).toContain("profile rows");
      },
      ARM_BUDGET_MS,
    );

    test(
      `ARM ${label} — the shape is indistinguishable from the ordinary path's`,
      async () => {
        // Compared against a REAL result from a real other path, never against
        // a literal typed out here.
        const early = await drive();
        const normal = await normalArm();
        expect(Object.keys(early).sort()).toEqual(Object.keys(normal).sort());
        expect(early.observed).toContain("── credential-free half ──");
        expect(early.observed).toContain("── live half ──");
        expect(normal.observed).toContain("── credential-free half ──");
        expect(early.did.length).toBeGreaterThan(0);
      },
      ARM_BUDGET_MS,
    );
  }
});
