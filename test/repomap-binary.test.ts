// SPDX-License-Identifier: Apache-2.0
/**
 * The one thing `bun test` cannot tell you about the repo map.
 *
 * #23 MEASURED the failure and named it: `bun --compile` embeds the tree-sitter
 * WASM, but Emscripten's default loader resolves it through a PATH, and inside
 * `/$bunfs/` that path does not exist. The error is
 * `ENOENT ... '/$bunfs/root/tree-sitter.wasm'`, raised from Emscripten's dylink
 * loader, and it appears only when the artifact is a compiled binary run from a
 * directory with no `node_modules` above it — which is every directory a user
 * runs brigadier from and no directory this suite runs in.
 *
 * So these tests compile, and run the compiled artifact from a temporary
 * directory. Ruling 62b's demonstrated negative is the third test: the same
 * runtime, brought up the obvious way instead of `src/repomap/grammars.ts`'s
 * way, is compiled and run in the same place and is asserted to FAIL with that
 * exact error. Without it, a green result here could mean the grammars load, or
 * it could mean `node_modules` was reachable all along.
 *
 * MEASURED against `bun 1.3.14` on 2026-08-18 on macOS 25.5.0 (darwin arm64).
 * The compiles below take roughly 150 ms each.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// The trailing separator is stripped because `REPO` is interpolated into import
// specifiers below, where `${REPO}//src` would be wrong. `fileURLToPath` returns
// the platform separator, so the class covers `\` as well as `/`.
const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

/**
 * What brigadier's own code is allowed to add to the Bun runtime it ships in.
 *
 * **RULED 2026-08-20. This replaces a 63 MiB budget on the TOTAL, which is
 * struck in the open** — `bar/items/10-the-artifact-ships.ts`'s
 * `STRUCK_TOTAL_SIZE_BUDGET_BYTES` carries the strike, its three reasons and the
 * promise it leaves unproven, and `BAR.md` carries the same. The short version:
 * the 63 MiB figure was never measured on anything (amendment §16 — one
 * unsourced sentence at `MEASUREMENT-SESSION.md:140`, commit `7e6a547`, the same
 * sentence behind the two start-up clauses already struck), and it is
 * unreachable on Linux by an amount no version of this product can close.
 *
 * MEASURED against `bun 1.3.14` on 2026-08-20, compiling `process.exit(0)` and
 * this file's own `cli + repo map` entry point back to back on each platform:
 *
 *   | platform      | empty floor | cli + repo map | brigadier's contribution |
 *   | darwin arm64  | 63,446,114  | 64,750,562     | **1,304,448** |
 *   | linux arm64   | 93,694,096  | 94,939,280     | **1,245,184** |
 *
 * The floors differ by 47%; the contributions agree to 4.5%. So the budget is on
 * the contribution, and the floor is subtracted by COMPILING an empty program
 * here rather than by looking one up — a pinned floor would go stale silently
 * the first time bun shipped.
 *
 * The number is 2.5 MiB: twice the largest measured contribution, by the same
 * rule `REPOMAP_SIZE_CAP_BYTES` below already uses. It is a JUDGEMENT and not a
 * measurement, and what it detects is growth in brigadier's own bytes — not the
 * size of the download, which is Bun's and which nothing here budgets.
 */
const BRIGADIER_SIZE_BUDGET_BYTES = 2_621_440;

/**
 * What the repo map slice is allowed to add to the binary.
 *
 * MEASURED against `bun 1.3.14` on 2026-08-18: the seven gzipped grammars plus
 * the tree-sitter runtime and its JavaScript glue cost **809,088 bytes**. The
 * same grammars imported raw from `node_modules` cost **5,515,008** — which is
 * why this cap is here rather than a comment. It is set at roughly twice the
 * measured cost: enough room for a grammar, not enough for the raw packaging to
 * come back.
 */
const REPOMAP_SIZE_CAP_BYTES = 1_500_000;

/** Below this the two binaries being compared are not really different. */
const REPOMAP_SIZE_FLOOR_BYTES = 500_000;

let workspace: string;
/** A directory with no `node_modules` anywhere above it. */
let elsewhere: string;

function compile(entry: string, out: string): void {
  const result = Bun.spawnSync(["bun", "build", "--compile", entry, "--outfile", out], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`compile of ${entry} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "brigadier-repomap-bin-"));
  elsewhere = mkdtempSync(join(tmpdir(), "brigadier-repomap-elsewhere-"));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

describe("the compiled binary loads the grammars", () => {
  test("all seven, and maps a real repository, from a directory with no node_modules", () => {
    const binary = join(workspace, "selfcheck");
    compile(join(REPO, "src", "repomap", "selfcheck.ts"), binary);

    const run = Bun.spawnSync([binary, REPO], { cwd: elsewhere, stdout: "pipe", stderr: "pipe" });
    const stdout = new TextDecoder().decode(run.stdout);
    expect(`exit ${String(run.exitCode)} ${new TextDecoder().decode(run.stderr)}`.trim()).toBe("exit 0");

    const report = JSON.parse(stdout) as {
      ok: boolean;
      grammars: string[];
      map: { filesInMap: number; estimatedTokens: number; budgetTokens: number };
    };
    expect(report.ok).toBe(true);
    // `abiVersion` is read back off the instantiated WASM module, so it cannot
    // be reported unless the grammar really was decompressed and linked.
    expect(report.grammars).toHaveLength(7);
    for (const loaded of report.grammars) expect(loaded).toMatch(/@abi\d+$/);
    expect(report.map.filesInMap).toBeGreaterThan(10);
    expect(report.map.estimatedTokens).toBeLessThanOrEqual(report.map.budgetTokens);
  });

  test("and the obvious way to load it FAILS in exactly that directory", () => {
    // The demonstrated negative. `Parser.init()` with Emscripten's default
    // loader is what #23 measured breaking, and it is asserted here so that the
    // test above cannot be passing for an environmental reason.
    const entry = join(workspace, "naive.ts");
    writeFileSync(
      entry,
      [
        `import { Parser } from "${REPO}/node_modules/web-tree-sitter/tree-sitter.js";`,
        "try {",
        "  await Parser.init();",
        '  console.log("INIT-OK");',
        "} catch (error) {",
        '  console.log("FAILED", error instanceof Error ? error.message : String(error));',
        "  process.exit(3);",
        "}",
        "",
      ].join("\n"),
    );
    const binary = join(workspace, "naive");
    compile(entry, binary);

    const run = Bun.spawnSync([binary], { cwd: elsewhere, stdout: "pipe", stderr: "pipe" });
    const output = `${new TextDecoder().decode(run.stdout)}${new TextDecoder().decode(run.stderr)}`;
    expect(run.exitCode).not.toBe(0);
    expect(output).toContain("/$bunfs/root/tree-sitter.wasm");
    expect(output).not.toContain("INIT-OK");
  });
});

describe("and it still fits the binary budget", () => {
  test("brigadier's own contribution is within budget, and the map's own cost is measured not assumed", () => {
    // The subtrahend, compiled here so that the two binaries being differenced
    // come from one bun on one platform. See `BRIGADIER_SIZE_BUDGET_BYTES`.
    const emptyEntry = join(workspace, "empty.ts");
    writeFileSync(emptyEntry, "process.exit(0);\n");
    const emptyBinary = join(workspace, "empty-floor");
    compile(emptyEntry, emptyBinary);

    const withoutMap = join(workspace, "cli-only");
    compile(join(REPO, "src", "cli.ts"), withoutMap);

    // The repo map is not wired into `src/cli.ts` by this slice — that file has
    // another owner — so the cost of adding it is measured on an entry point
    // that pulls in both. The number this produces is what the shipped binary
    // will grow by when it is wired in.
    const entry = join(workspace, "cli-plus-map.ts");
    writeFileSync(
      entry,
      [
        `import { buildRepoMap } from "${REPO}/src/repomap/index.ts";`,
        // Referenced behind a condition that is never true, so the bundler
        // cannot drop it and the binary never actually builds a map here.
        'if (process.env["BRIGADIER_NEVER"] === "1") console.log(await buildRepoMap("."));',
        `await import("${REPO}/src/cli.ts");`,
        "",
      ].join("\n"),
    );
    const withMap = join(workspace, "cli-plus-map");
    compile(entry, withMap);

    const floor = statSync(emptyBinary).size;
    const before = statSync(withoutMap).size;
    const after = statSync(withMap).size;
    const cost = after - before;
    const contribution = after - floor;

    // Demonstrated negative: the two binaries really are different. A cost of
    // zero would mean the grammars were tree-shaken out and every assertion
    // about size below would be vacuous.
    expect(cost).toBeGreaterThan(REPOMAP_SIZE_FLOOR_BYTES);
    expect(cost).toBeLessThan(REPOMAP_SIZE_CAP_BYTES);

    // AND THE SAME NEGATIVE FOR THE FLOOR. A floor equal to the artifact would
    // make the contribution zero and this budget unfailable — which is exactly
    // the shape a check acquires when nobody checks that its subtrahend is a
    // different thing from its minuend.
    const why =
      `empty-program floor ${floor}; cli-only ${before}; cli+map ${after}; ` +
      `brigadier's contribution ${contribution} bytes against a budget of ${BRIGADIER_SIZE_BUDGET_BYTES}. ` +
      `The floor is ${((floor / after) * 100).toFixed(2)}% of the artifact and belongs to bun ${Bun.version} on ` +
      `${process.platform}/${process.arch}; this budget deliberately makes no claim about it`;
    expect(contribution, why).toBeGreaterThan(REPOMAP_SIZE_FLOOR_BYTES);
    // The number that decides whether this slice can ship.
    expect(contribution, why).toBeLessThanOrEqual(BRIGADIER_SIZE_BUDGET_BYTES);
  });
});
