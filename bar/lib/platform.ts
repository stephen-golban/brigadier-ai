// SPDX-License-Identifier: Apache-2.0
/**
 * A platform-gated test that CANNOT run here, said out loud instead of skipped.
 *
 * **RULED 2026-08-20**, settling `OWNER-QUESTIONS.md` #6, the owner having
 * delegated that round's rulings.
 *
 * Eleven tests carried `if (process.platform === "win32") return;` **in the test
 * body**. A test that returns early reports `(pass)` — `bar/lib/orphan.test.ts`
 * did it in 0.36 ms on `windows-latest` and failed after 20,073 ms on both Ubuntu
 * and macOS — and `scripts/test-gate.ts` counts skip, todo, fail and error, so it
 * could see none of them. Eleven checks reported success on the platform ruling
 * 12 makes first class, having exercised nothing.
 *
 * That is the *check that reports success when the thing it checks did not
 * happen* shape v1 shipped four times, and it is worse than a red test because
 * nobody goes looking for it. Ruling 62 (c) is explicit — *"a platform-gated test
 * must run on that platform, so CI on all three is not optional"* — and amendment
 * §9 records the standing posture for exactly these unmeasured Windows paths:
 * they are *"deliberately left to fail loudly on windows-latest rather than hide
 * behind a skip"*. Eleven tests were doing the opposite of that.
 *
 * **THE RULING: they become blocking failures, named.** Not skips — ruling 48
 * makes a SKIPPED item block exactly as a FAIL does, and `bun run test-gate`
 * already refuses a skipped test, so a skip is not available anyway. Each call
 * site says WHAT did not run and WHY, because the remedy differs per test and
 * "unsupported on Windows" is not a remedy anyone can act on.
 *
 * **THE ACCEPTED COST, and it is the whole of why this needed deciding.** This
 * makes `windows-latest` REDDER before it makes it greener: eleven silent passes
 * become eleven visible failures on a leg that has never been green, taking it
 * from ~81 to ~92. Nothing is more broken than it was five minutes ago; what
 * changes is that the count is now true. A CI that is green because a check was
 * weakened is worse than one that is red honestly, and a count that is low
 * because eleven checks vanished is the same defect wearing a number.
 *
 * **What this does NOT do**, said here so nobody reads it as more than it is: it
 * writes no Windows implementation. Every message below names the mechanism that
 * would have to be built, and until one is, the property that test proves is
 * UNPROVEN on Windows — which is what the failure now says.
 */

/**
 * Fail this test, on this platform, for a stated reason.
 *
 * `never`, so a call site needs no `return` after it and TypeScript narrows the
 * rest of the body correctly.
 */
export function notRunHere(what: string, why: string): never {
  throw new Error(
    `NOT-RUN on ${process.platform} — ${what}. ${why} ` +
      "Ruling 62 (c): a platform-gated test must RUN on that platform, so this is a blocking " +
      "failure and not a skip, and not the silent early return that stood here until 2026-08-20. " +
      "See bar/lib/platform.ts for the ruling and its accepted cost.",
  );
}
