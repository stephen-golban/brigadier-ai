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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * v1's shipped binary, MEASURED at 63 MB where the tooling's "MB" is bytes /
 * 1048576 — so 63 MiB, stated in bytes here for the same reason
 * `bar/items/10-the-artifact-ships.ts` states it in bytes: 63.48 MB decimal is
 * over a 63 MB decimal budget while 60.54 MiB is under a 63 MiB one, and the
 * two readings disagree about the verdict.
 */
const SIZE_BUDGET_BYTES = 63 * 1_048_576;

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
  test("cli plus repo map is under 63 MiB, and the map's own cost is measured not assumed", () => {
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

    const before = statSync(withoutMap).size;
    const after = statSync(withMap).size;
    const cost = after - before;

    // Demonstrated negative: the two binaries really are different. A cost of
    // zero would mean the grammars were tree-shaken out and every assertion
    // about size below would be vacuous.
    expect(cost).toBeGreaterThan(REPOMAP_SIZE_FLOOR_BYTES);
    expect(cost).toBeLessThan(REPOMAP_SIZE_CAP_BYTES);
    // The number that decides whether this slice can ship.
    expect(after).toBeLessThanOrEqual(SIZE_BUDGET_BYTES);
  });
});
