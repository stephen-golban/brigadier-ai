// SPDX-License-Identifier: Apache-2.0
/**
 * The path spellings `refuseInsideRepo` compares, measured rather than assumed.
 *
 * **What this exists to settle.** VERIFIED against run 32398251476 on
 * 2026-08-20, `windows-latest`: both arms of `test/isolation.test.ts`'s *"the
 * temporary index is nowhere near the operator's repository"* failed there, and
 * they failed by throwing the WRONG error —
 *
 *     Expected pattern: /temporary index inside the operator's repository/
 *     Received message: "ruling 50: brigadier disturbed the operator's
 *                        repository while building the temporary index —
 *                        git status changed"
 *
 * `refuseInsideRepo` did not fire. The scratch directory was created inside the
 * operator's repository, `git add -A` swept it, and only ruling 50's
 * disturbance witness noticed — a SECOND, weaker guard that fires on a symptom
 * rather than on the cause. It fires only because the sweep changed `git
 * status`; a scratch index landing somewhere already ignored would move nothing
 * and be caught by nothing. So the promise *"the temporary index is nowhere
 * near the operator's repository"* is unproven on the platform ruling 12 makes
 * first class.
 *
 * **And the same measurement found the guard half-dead HERE.** MEASURED on
 * darwin 25.5.0 with git 2.51.0 on 2026-08-20 by this file's own first draft: a
 * repository under `$TMPDIR` is handed to `buildBaseState` as
 * `/var/folders/…/operator-repo` while `git rev-parse --show-toplevel` reports
 * `/private/var/folders/…/operator-repo`, and the pre-`mkdir` check used
 * `resolve()`, which never crosses the `/var` → `/private/var` symlink. A
 * candidate genuinely inside the repository therefore failed `startsWith`, and
 * the refusal that exists SO THAT NO DIRECTORY IS CREATED did not fire; the
 * post-`mkdir` check caught it after creating the directory. That is why
 * `base.ts` now resolves the candidate with `intendedRealPath`.
 *
 * This file measures the three spellings side by side, names which one drifted
 * in its own failure message, and puts `refuseInsideRepo` itself to both the
 * resolved and the unresolved form. It blocks, and it is meant to: a guard that
 * cannot fire looks exactly like a guard that works.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { refuseInsideRepo } from "../src/isolation/base.ts";
import { intendedRealPath } from "../src/isolation/clone.ts";

let scratch: string;
/** What a caller hands `buildBaseState` as `repo` — NOT necessarily realpathed. */
let given: string;
/** What `git rev-parse --show-toplevel` prints for it. */
let toplevel: string;
/** What `buildBaseState` compares against: `realpathSync` of the above. */
let canonical: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${proc.exitCode}: ${err}`);
  return out.trim();
}

/** Every spelling, in one block, so a failing assertion says which drifted. */
function readings(): string {
  return (
    `\n  platform          ${process.platform}, sep ${JSON.stringify(sep)}` +
    `\n  tmpdir()          ${JSON.stringify(tmpdir())}` +
    `\n  given to caller   ${JSON.stringify(given)}` +
    `\n  resolve(given)    ${JSON.stringify(resolve(given))}` +
    `\n  --show-toplevel   ${JSON.stringify(toplevel)}` +
    `\n  realpathSync      ${JSON.stringify(canonical)}` +
    `\n  intendedRealPath  ${JSON.stringify(intendedRealPath(join(given, "scratch")))}\n`
  );
}

/** `refuseInsideRepo` throws or it does not; this reports which, with the message. */
function refusal(candidate: string): string | null {
  try {
    refuseInsideRepo(candidate, canonical);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "brigadier-pathshape-"));
  given = join(scratch, "operator-repo");
  mkdirSync(given, { recursive: true });
  await git(given, "init", "-q");
  toplevel = await git(given, "rev-parse", "--show-toplevel");
  canonical = realpathSync(toplevel);
}, 30_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the spellings `refuseInsideRepo` compares", () => {
  test("THE GUARD FIRES on a scratch directory inside the repository, resolved as the product resolves it", () => {
    // This is the exact call `buildBaseState` makes before `mkdirSync`. If it
    // does not throw, the guard is dead on this platform and a temporary index
    // gets built inside the operator's repository.
    expect(
      refusal(intendedRealPath(join(given, "scratch"))),
      "`refuseInsideRepo` did not refuse a directory that IS inside the operator's repository. " +
        "The comparison is a prefix test between two spellings of the same path, and on this " +
        "platform they do not overlap." + readings(),
    ).toMatch(/temporary index inside the operator's repository/);
  });

  test("THE GUARD FIRES on the repository root itself, not only on a child", () => {
    expect(refusal(canonical), `the root itself is inside the repository.${readings()}`).toMatch(
      /temporary index inside the operator's repository/,
    );
  });

  test("NEGATIVE CONTROL: a sibling directory is NOT refused", () => {
    // Without this the two above would pass on a guard that refuses everything,
    // which would break every real caller and look like a working check here.
    expect(
      refusal(intendedRealPath(join(scratch, "outside"))),
      `a directory beside the repository must be allowed.${readings()}`,
    ).toBeNull();
  });

  test("NEGATIVE CONTROL: a sibling whose NAME merely starts with the repository's is not refused", () => {
    expect(
      refusal(intendedRealPath(`${given}-elsewhere`)),
      "a `startsWith` without the separator would refuse this, and refusing it would be wrong." +
        readings(),
    ).toBeNull();
  });

  test("THE macOS CAUSE, pinned: the UNRESOLVED spelling does not overlap, and that is why `resolve()` was not enough", () => {
    // Not an assertion that the two differ — on Linux they do not — but that
    // the product does not DEPEND on their agreeing. `intendedRealPath` of the
    // caller's own spelling must land on the canonical one either way.
    expect(
      intendedRealPath(given),
      "`intendedRealPath` must map the caller's spelling of the repository onto the same path " +
        "`git rev-parse --show-toplevel` reports, or the pre-`mkdir` refusal cannot fire." +
        readings(),
    ).toBe(canonical);
  });

  test("WHICH SPELLING DRIFTED, if any: separators", () => {
    expect(
      toplevel.includes("/") === canonical.includes("/") && toplevel.includes("\\") === canonical.includes("\\"),
      "`git rev-parse --show-toplevel` and `realpathSync` disagree about the path SEPARATOR — " +
        "that is the separator hypothesis, confirmed." + readings(),
    ).toBe(true);
  });

  test("WHICH SPELLING DRIFTED, if any: segments", () => {
    // 8.3 short names, drive-letter case, or a junction: anything that changes
    // a segment rather than a separator. Separators are normalised away here so
    // that this arm answers a different question from the one above.
    const flat = (p: string): string => p.replace(/[\\/]+/g, "/").toLowerCase();
    expect(
      flat(toplevel),
      "`git rev-parse --show-toplevel` and `realpathSync` disagree about a path SEGMENT — an " +
        "8.3 short name, a junction, or drive-letter case — not merely about separators." + readings(),
    ).toBe(flat(canonical));
  });
});
