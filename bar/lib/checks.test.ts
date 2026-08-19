// SPDX-License-Identifier: Apache-2.0
/**
 * The negative control for the accumulator every item's judgement is built on.
 *
 * WHAT FAILED. `Checks.note` stamps `ok: true` and is filtered out of
 * `failures`, so a note contributes nothing to a verdict. Until 2026-08-19 it
 * also RENDERED identically to a passing assertion — `ok  <name> (note): …` —
 * so neither the report nor the halves gave a reader any way to tell an
 * assertion that passed from one that was never made. That shipped once, on
 * item 10: `BAR.md` names `claude plugin details brigadier` as its own
 * instrument for the host half, item 10 recorded the unavailable host as a
 * note, and the item printed PASS on a CI leg where that instrument never
 * executed. `bar/items.test.ts:1045-1066` is the regression control for that
 * ONE instance — it pins item 10's host row as `NOT-RUN —` and `ok: false`.
 * Nothing pinned the mechanism underneath it, and `bar/lib/checks.ts` is
 * imported by all thirteen items.
 *
 * WHAT THIS FILE EXISTS TO PREVENT. Two things, and they are different.
 *
 *   1. The rendering guard silently coming back out. `render` now leads a note
 *      with `note`, and ruling 62(b) is explicit that a guard without a
 *      demonstrated negative looks identical to a working one — so the leader
 *      is asserted on the actual rendered bytes, never on the `note` flag that
 *      produces them.
 *   2. The remaining hazard being mistaken for an oversight. A `Checks` holding
 *      nothing but notes still reports `passed === true`. That is PINNED below,
 *      deliberately, and it is a HAZARD, not a promise: every `note()` call site
 *      is an item choosing not to gate on something, and whether that choice is
 *      right is answered per item — 19 live call sites under `bar/items/` as
 *      MEASURED against `rg 14.1.1` on 2026-08-19 — not by this class. What the
 *      class owes a reader is that the choice is VISIBLE. If a later change
 *      makes notes block, this test is the one that must be rewritten, and the
 *      rewrite is the decision being taken in the open rather than by accident.
 *
 * AND THE SEAM. The leader alone was not enough. Items build their judgement in
 * pieces and merge the pieces, and the merge idiom RECONSTRUCTED each row —
 * `for (const row of judgeCost(…).rows) checks.expect(row.name, row.ok, row.detail)`
 * — so a note came out of the merge indistinguishable from a pass all over
 * again. Fifteen call sites did that, including the one on item 13 whose note
 * names "what #45 leaves unproven" about a cost figure. `absorb` copies rows
 * instead, and is pinned below both for what it preserves and for what the old
 * idiom lost.
 *
 * `BAR.md`: "A `SKIPPED` item blocks a tag exactly as a `FAIL` does. A check
 * that did not run is not a check that passed." A note is neither, and after
 * this round the report says so out loud.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { Checks, excerpt } from "./checks.ts";

describe("Checks.expect", () => {
  test("a passing assertion records its bytes and stays out of failures", () => {
    const checks = new Checks();
    const returned = checks.expect("the vendor is on PATH", true, "/usr/local/bin/claude");

    expect(returned).toBe(true);
    expect(checks.rows).toEqual([{ name: "the vendor is on PATH", ok: true, detail: "/usr/local/bin/claude" }]);
    expect(checks.failures).toEqual([]);
    expect(checks.passed).toBe(true);
    expect(checks.reason()).toBeUndefined();
  });

  test("a failing assertion blocks, and says what it saw", () => {
    const checks = new Checks();
    const returned = checks.expect("the vendor is on PATH", false, "not found on PATH");

    expect(returned).toBe(false);
    expect(checks.failures.map((r) => r.name)).toEqual(["the vendor is on PATH"]);
    expect(checks.passed).toBe(false);
    expect(checks.reason()).toBe("the vendor is on PATH — not found on PATH");
  });

  test("one failure among passes is enough, and reason() names every failure", () => {
    const checks = new Checks();
    checks.expect("first", true, "seen");
    checks.expect("second", false, "missing");
    checks.expect("third", true, "seen");
    checks.expect("fourth", false, "wrong bytes");

    expect(checks.passed).toBe(false);
    expect(checks.failures.map((r) => r.name)).toEqual(["second", "fourth"]);
    expect(checks.reason()).toBe("second — missing; fourth — wrong bytes");
  });

  test("an empty Checks passes — which is why an item that reaches no assertion must not report one", () => {
    // Not a bug to fix here: `combine` in `bar/lib/halves.ts` prints "no
    // credential-free assertions in this item" rather than a blank PASS. Pinned
    // so a change to `passed` cannot make an empty accumulator block without
    // someone reading this line first.
    const checks = new Checks();
    expect(checks.passed).toBe(true);
    expect(checks.render()).toBe("");
  });
});

describe("Checks.note — the hazard, pinned in the open", () => {
  test("HAZARD: a Checks carrying only notes reports passed === true and no failures", () => {
    // This is the `SKIPPED` in a note's clothes that `bar/lib/checks.ts`'s own
    // header names. It is asserted here because it is KNOWN, not because it is
    // correct: a note gates nothing, so an item that records a blocking
    // condition as a note reports PASS. The fix is per call site — turning the
    // ones that describe a blocking condition into `expect(name, false, …)` —
    // and two of them need an owner ruling first. Until then the mechanism is
    // written down instead of discovered.
    const checks = new Checks();
    checks.note("the host was never asked", "claude is not installed on this runner");
    checks.note("what the struck clause leaves unproven", "cold start, on a cold FS cache");

    expect(checks.rows).toHaveLength(2);
    expect(checks.failures).toEqual([]);
    expect(checks.passed).toBe(true);
    expect(checks.reason()).toBeUndefined();
  });

  test("a note does not rescue a failure, and does not create one", () => {
    const checks = new Checks();
    checks.expect("the promise holds", false, "it did not");
    checks.note("context", "worth knowing");

    expect(checks.passed).toBe(false);
    expect(checks.failures.map((r) => r.name)).toEqual(["the promise holds"]);
    expect(checks.reason()).toBe("the promise holds — it did not");
  });

  test("a note keeps the ` (note)` name suffix item 10's controls filter gates on", () => {
    const checks = new Checks();
    checks.note("what the struck clause leaves unproven", "cold start");

    expect(checks.rows[0]?.name).toBe("what the struck clause leaves unproven (note)");
    expect(checks.rows.filter((r) => !r.name.endsWith("(note)"))).toEqual([]);
  });
});

describe("Checks.render — a note must not read as a pass", () => {
  test("the three leaders are distinct in the rendered bytes", () => {
    const checks = new Checks();
    checks.expect("an assertion that passed", true, "seen");
    checks.expect("an assertion that failed", false, "not seen");
    checks.note("something never asserted", "reported only");

    const lines = checks.render().split("\n");
    expect(lines).toEqual([
      "ok   an assertion that passed: seen",
      "FAIL an assertion that failed: not seen",
      "note something never asserted (note): reported only",
    ]);
  });

  test("THE GUARD: no rendered note line begins with the passing leader", () => {
    // The defect, stated as the bytes a reader sees. Before 2026-08-19 this
    // line read `ok  what the host proved (note): …` and was indistinguishable
    // from the line above it. Asserted on `render()` output rather than on the
    // `note` flag, because the flag is the implementation and the leader is the
    // promise.
    const checks = new Checks();
    checks.expect("what the host proved", true, "PreCompact is named");
    checks.note("what the host proved", "the host was never asked");

    const [pass, note] = checks.render().split("\n");
    expect(pass).toBe("ok   what the host proved: PreCompact is named");
    expect(note).toBe("note what the host proved (note): the host was never asked");
    expect(note?.startsWith("ok")).toBe(false);
    expect(pass?.slice(0, 4)).not.toBe(note?.slice(0, 4));
  });

  test("every leader is four columns, so the names stay in one column", () => {
    const checks = new Checks();
    checks.expect("a", true, "x");
    checks.expect("b", false, "x");
    checks.note("c", "x");

    for (const line of checks.render().split("\n")) {
      expect(line.slice(4, 5)).toBe(" ");
    }
  });

  test("render keeps the detail bytes verbatim, including the ones a reader would grep for", () => {
    const checks = new Checks();
    checks.expect("NOT-RUN — the base-tree scan", false, "git: exit 128");

    expect(checks.render()).toBe("FAIL NOT-RUN — the base-tree scan: git: exit 128");
  });
});

describe("excerpt", () => {
  test("collapses whitespace and returns short text unchanged", () => {
    expect(excerpt("one\n  two\tthree ")).toBe("one two three");
  });

  test("empty and whitespace-only input is marked, not silently blank", () => {
    expect(excerpt("")).toBe("<empty>");
    expect(excerpt("   \n\t ")).toBe("<empty>");
  });

  test("text exactly at the limit is not trimmed", () => {
    const flat = "x".repeat(300);
    expect(excerpt(flat)).toBe(flat);
  });

  test("MARKS THE TRIM: over the limit, the total length is reported so nothing is hidden", () => {
    const flat = "x".repeat(451);
    const out = excerpt(flat);

    expect(out).toBe(`${"x".repeat(300)}… (451 chars total)`);
    expect(out).toContain("451 chars total");
    expect(out.startsWith("x".repeat(300))).toBe(true);
  });

  test("the limit is a parameter, and the reported total is of the COLLAPSED text", () => {
    // 10 words of 3 chars plus 9 single spaces collapses to 39 chars, whatever
    // the original whitespace was.
    const noisy = Array.from({ length: 10 }, () => "abc").join("\n\n   ");
    expect(excerpt(noisy, 5)).toBe("abc a… (39 chars total)");
  });
});

describe("Checks.absorb — the merge seam", () => {
  const source = (): Checks => {
    const s = new Checks();
    s.expect("a proven thing", true, "seen");
    s.note("what #45 leaves unproven", "no instrument for it on this machine");
    s.expect("a broken promise", false, "not seen");
    return s;
  };

  test("THE SEAM'S GUARD: a note copied through absorb still renders with the note leader", () => {
    // The whole reason `absorb` exists. Asserted on the merged accumulator's
    // rendered bytes, because that is what a reader of the report sees.
    const merged = new Checks();
    merged.absorb(source());

    const noteLine = merged
      .render()
      .split("\n")
      .find((l) => l.includes("what #45 leaves unproven"));
    expect(noteLine).toBe("note what #45 leaves unproven (note): no instrument for it on this machine");
    expect(noteLine?.startsWith("ok")).toBe(false);
  });

  test("THE DEFECT, DEMONSTRATED: reconstructing the same rows through expect loses the leader", () => {
    // This is the idiom `absorb` replaced, run here on purpose so the guard
    // above has a demonstrated negative. `expect` takes three fields, a row has
    // four, and the one it drops is the one that says "this asserted nothing".
    const rebuilt = new Checks();
    for (const row of source().rows) rebuilt.expect(row.name, row.ok, row.detail);

    const noteLine = rebuilt
      .render()
      .split("\n")
      .find((l) => l.includes("what #45 leaves unproven"));
    expect(noteLine).toBe("ok   what #45 leaves unproven (note): no instrument for it on this machine");
    expect(noteLine?.startsWith("note")).toBe(false);
  });

  test("absorb moves no verdict: a copied failure still fails, a copied note still gates nothing", () => {
    const merged = new Checks();
    merged.absorb(source());

    expect(merged.rows).toHaveLength(3);
    expect(merged.passed).toBe(false);
    expect(merged.failures.map((r) => r.name)).toEqual(["a broken promise"]);
    expect(merged.reason()).toBe("a broken promise — not seen");

    const notesOnly = new Checks();
    const justNotes = new Checks();
    justNotes.note("nothing was asserted", "reported only");
    notesOnly.absorb(justNotes);
    expect(notesOnly.passed).toBe(true);
    expect(notesOnly.failures).toEqual([]);
  });

  test("absorb appends in order, after what the receiver already holds, and can be called twice", () => {
    const merged = new Checks();
    merged.expect("first, the receiver's own", true, "x");
    merged.absorb(source());
    merged.absorb(source());

    expect(merged.rows.map((r) => r.name)).toEqual([
      "first, the receiver's own",
      "a proven thing",
      "what #45 leaves unproven (note)",
      "a broken promise",
      "a proven thing",
      "what #45 leaves unproven (note)",
      "a broken promise",
    ]);
  });

  test("absorb copies rather than aliases, so the source cannot be mutated through the receiver", () => {
    const s = source();
    const merged = new Checks();
    merged.absorb(s);

    const copied = merged.rows[0];
    if (copied !== undefined) copied.detail = "rewritten after the fact";
    expect(s.rows[0]?.detail).toBe("seen");
  });

  test("absorbing an empty Checks adds nothing and decides nothing", () => {
    const merged = new Checks();
    merged.expect("the only assertion", true, "seen");
    merged.absorb(new Checks());

    expect(merged.rows).toHaveLength(1);
    expect(merged.passed).toBe(true);
  });
});

describe("the merge idiom is gone, and stays gone", () => {
  test("no item reconstructs rows through expect — that path silently drops fields", () => {
    // The rendering guard and `absorb` together are only worth what this test
    // is worth: the old idiom is one line and reads as harmless, so it will be
    // reached for again by habit unless something says no. Scanned over
    // `bar/items/` — where every one of the fifteen call sites lived — as
    // MEASURED against `bun 1.3.14` on 2026-08-19. The needle is assembled from
    // fragments so this file does not match itself.
    const needle = new RegExp(`\\.expect\\(\\s*row\\.${"name"}, row\\.${"ok"}, row\\.${"detail"}\\s*\\)`);
    const itemsDir = join(import.meta.dir, "..", "items");
    const offenders = readdirSync(itemsDir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => needle.test(readFileSync(join(itemsDir, f), "utf8")));

    expect(offenders).toEqual([]);
    expect(readdirSync(itemsDir).filter((f) => f.endsWith(".ts")).length).toBeGreaterThan(10);
  });
});
