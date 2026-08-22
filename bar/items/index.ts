// SPDX-License-Identifier: Apache-2.0
/**
 * The register of items, and the reason it is a list rather than a directory scan.
 *
 * `BAR.md` defines FIFTEEN items — ruling 48 described ten, phase 2 added
 * item 11 (ruling 58), item 12 (ruling 65) and item 13 (ruling 66), item 14
 * was added on 2026-08-20 after an independent verifier read 13 PASS on an
 * artifact whose every direct agent profile was unstartable, and item 15 on
 * 2026-08-22 under ruling 82 — the only one that asks whether the RULINGS match
 * the owner rather than whether the code matches the rulings. All fifteen
 * are registered from the start, including the ones whose product feature does
 * not exist yet, because a missing item is invisible and the document's whole
 * point is that completeness is checkable.
 *
 * **The count is NOT declared here.** It was, and a blind critic deleted three
 * items and edited the constant on an adjacent line in the same file, producing
 * `10/10 PASS · 0 blocking`, exit 0 and no INCOMPLETE line — a fully green
 * release bar on a binary that does nothing. The only thing that would have
 * caught it lived in `bun test`, the suite `BAR.md` explicitly says the bar is
 * separate from.
 *
 * So the runner derives the item set from `BAR.md` at run time (`bar/lib/spec.ts`)
 * and refuses to run if this register disagrees with it in either direction —
 * a missing item, an extra one, a drifted title, a ruling list that lost an
 * entry. `BAR.md` is the specification; this file is an implementation of it,
 * and a constant that can be edited beside the thing it guards is not a guard.
 *
 * That is also the mechanical form of `BAR.md`'s closing rule: an item is struck
 * only in the open, by editing the document, with a line saying which item, why,
 * and what promise is therefore unproven. Never quietly disabled, never marked
 * "known failing", and never left `SKIPPED` while a tag goes out.
 */

import type { BarItem } from "../types.ts";
import item01 from "./01-detection-is-honest.ts";
import item02 from "./02-the-lane-holds.ts";
import item03 from "./03-no-foreign-file-touched.ts";
import item04 from "./04-fanout-isolates.ts";
import item05 from "./05-review-is-cross-vendor.ts";
import item06 from "./06-single-vendor-degrades-visibly.ts";
import item07 from "./07-interruption-leaves-nothing.ts";
import item08 from "./08-impossible-plan-refused.ts";
import item09 from "./09-ambient-instructions-suppressed.ts";
import item10 from "./10-the-artifact-ships.ts";
import item11 from "./11-report-fits-the-window.ts";
import item12 from "./12-secret-not-persisted.ts";
import item13 from "./13-cost-model.ts";
import item14 from "./14-real-fleet-starts.ts";
import item15 from "./15-matches-the-owner.ts";

export const ITEMS: readonly BarItem[] = [
  item01,
  item02,
  item03,
  item04,
  item05,
  item06,
  item07,
  item08,
  item09,
  item10,
  item11,
  item12,
  item13,
  item14,
  item15,
];

