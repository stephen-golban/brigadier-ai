// SPDX-License-Identifier: Apache-2.0
/**
 * The instrument's two controls, driven end to end.
 *
 * **The negative, and it is the one that matters.** A blind critic wrote a
 * brigadier whose entire behaviour was `console.log` plus one hand-written
 * 41-byte ref file — no agent, no clone, no worker, no subprocess, no merge —
 * and the first draft of this harness scored it **10 of 13 PASS**. The
 * instrument read zero at the time only because the product was unbuilt; it
 * would have read high the moment anything shipped that printed plausible
 * sentences, and every later slice would have been graded by it.
 *
 * `bar/fakes/printer.ts` is that binary, checked in and deliberately generous to
 * itself. If a change to `bar/` ever lets it score above zero, that change has
 * broken the instrument, whatever else it did.
 *
 * **The positive.** "Every item fails" is worthless on its own — three items in
 * the first draft were unsatisfiable by construction and nobody could tell them
 * apart from an unbuilt product. `bar/fakes/honest.ts` really clones, really
 * spawns workers, really merges with `git merge-tree`, really writes a record
 * and really re-raises a second interrupt, and the items it covers must PASS.
 *
 * These are the slowest tests in the repository by a wide margin, and that is
 * the price of an instrument that has been checked rather than assumed.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ITEMS } from "./items/index.ts";
import { pruneEmpty, removeDir, writeScript } from "./lib/fs.ts";
import { runBar } from "./run.ts";
import type { BarItem, BarRecord } from "./types.ts";

const PRINTER = fileURLToPath(new URL("./fakes/printer.ts", import.meta.url));
const HONEST = fileURLToPath(new URL("./fakes/honest.ts", import.meta.url));
const FORGER = fileURLToPath(new URL("./fakes/forger.ts", import.meta.url));

/**
 * Wrap a fixture as an executable, so the harness drives it exactly as it drives
 * a release artifact — argv, stdin, stdout, exit code and the filesystem, with
 * no in-process shortcut that could hide a difference.
 */
function asBinary(dir: string, script: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  return writeScript(
    join(dir, name),
    `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
  );
}

// The work root lives outside every temp root, because ruling 61 is one of the
// things being checked and a harness under `/tmp` would fail its own item.
const ROOTS = join(homedir(), ".brigadier-bar-tests");
function workroot(name: string): string {
  const root = join(ROOTS, `${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}
// Item 3 asserts brigadier leaves no trace in directories it does not own. A
// test suite that left its own bucket under `$HOME` would be holding the product
// to a standard the harness does not meet itself.
afterAll(() => pruneEmpty(ROOTS));

async function score(binary: string, items: readonly BarItem[], live: boolean, root: string): Promise<BarRecord[]> {
  return runBar(items, { binary, live, json: true, workroot: root, log: () => {} });
}

describe("the do-nothing binary must fail every item", () => {
  test(
    "a brigadier that only prints scores 0 of 13",
    async () => {
      const root = workroot("printer");
      const binary = asBinary(join(root, "bin"), PRINTER, "brigadier-printer");
      try {
        // `--live` on purpose: a liar must not be able to hide behind a skip
        // either. This is the harshest setting available to it.
        const records = await score(binary, ITEMS, true, root);
        const passing = records.filter((r) => r.outcome === "PASS");
        expect(passing.map((r) => `${r.id} ${r.title}`)).toEqual([]);
        expect(records).toHaveLength(13);
      } finally {
        removeDir(root);
      }
    },
    600_000,
  );

  test(
    "and it fails them offline too, where the credential-free halves are graded",
    async () => {
      const root = workroot("printer-offline");
      const binary = asBinary(join(root, "bin"), PRINTER, "brigadier-printer");
      try {
        const records = await score(binary, ITEMS, false, root);
        expect(records.filter((r) => r.outcome === "PASS")).toEqual([]);
        // Every item that has a credential-free half must be judging it, not
        // deferring it: five items were computing one and discarding it.
        const graded = records.filter((r) => r.halves !== undefined);
        expect(graded.length).toBe(13);
      } finally {
        removeDir(root);
      }
    },
    600_000,
  );
});

describe("the SOPHISTICATED forger must fail every item", () => {
  // The printer is a solved problem. This one runs real `git`, writes real
  // objects, produces refs that pass `git fsck`, and writes a plausible run
  // record — and implements no promise. It scored **12 of 13** against the
  // previous harness in a single run.
  test(
    "a brigadier with real git and no work scores 0 of 13",
    async () => {
      const root = workroot("forger");
      const binary = asBinary(join(root, "bin"), FORGER, "brigadier-forger");
      try {
        const records = await score(binary, ITEMS, true, root);
        expect(records.filter((r) => r.outcome === "PASS").map((r) => `${r.id} ${r.title}`)).toEqual([]);
        expect(records).toHaveLength(13);
      } finally {
        removeDir(root);
      }
    },
    900_000,
  );
});

describe("the honest fixture must pass the items it implements", () => {
  // Items 1 and 10 measure the real artifact — ACP detection against a planted
  // agent, and the licence text, size and start-up of a compiled binary — so a
  // script fixture is the wrong subject for them and they are driven against
  // `dist/brigadier` by the bar itself rather than here.
  // Item 5 is deliberately absent: it drives the operator's REAL credentialed
  // fleet, because ruling 43 and #41 measured an approved permission escaping a
  // vendor's own sandbox and no fixture we write can reproduce that. A fixture
  // passing it would mean the item had quietly stopped needing real vendors.
  const covered = [2, 3, 4, 6, 7, 8, 9, 11, 12, 13];

  test(
    "a brigadier that really clones, spawns, merges and records passes them",
    async () => {
      const root = workroot("honest");
      const binary = asBinary(join(root, "bin"), HONEST, "brigadier-honest");
      try {
        const records = await score(
          binary,
          ITEMS.filter((i) => covered.includes(i.id)),
          true,
          root,
        );
        const failing = records.filter((r) => r.outcome !== "PASS");
        expect(failing.map((r) => `item ${r.id}: ${r.reason ?? r.outcome}`)).toEqual([]);
      } finally {
        removeDir(root);
      }
    },
    900_000,
  );
});
