// SPDX-License-Identifier: Apache-2.0
/**
 * Which fleet an item drives, and the reason the answer is not "always the same".
 *
 * Planting fixture agents makes an item reproducible on any machine, including
 * `BAR.md`'s hostile-but-legal CI leg where no vendor credential exists. That is
 * the right default for the items whose subject is brigadier's own behaviour —
 * isolation, integration, sweeping, ceilings, reporting.
 *
 * It is the WRONG default for an item whose subject is a VENDOR's behaviour.
 * Ruling 43 and #41 measured that an APPROVED `session/request_permission` on
 * Codex runs the command outside its own OS sandbox, and #50 found opencode has
 * no boundary of any kind for execute-class work. No stub we write can
 * reproduce either: a fixture denies what we told it to deny.
 *
 * **Exactly ONE item drives the operator's real, credentialed fleet: item 5.**
 * It is the only caller of `detectRealFleet` below, and `bar/fleet-claim.test.ts`
 * asserts that over the whole tree so this paragraph cannot go stale in silence.
 *
 * This comment used to say "items 2 and 5", and item 2's code has always planted
 * fixtures. That is ruling 62(g)'s failure class exactly — a claim living in a
 * file nobody edits, passing every gate because a comment is just text — and it
 * was load-bearing here, because this is the document telling a reader which
 * results are credentialed. Corrected in the direction of the code, deliberately:
 * pointing item 2 at the real fleet would spend real vendor tokens on every run
 * and is a scheduling decision, not a comment fix.
 *
 * **The cost of that, stated rather than buried:** item 2's lane checks run
 * against a fixture that denies what it was told to deny, so item 2 does NOT
 * reproduce #41's approved-permission escape. It measures brigadier's lane, not
 * a vendor's sandbox. Ruling 43's escape remains covered only by item 5.
 *
 * If the real fleet cannot supply what the item needs, the item says that too
 * rather than silently substituting fixtures — a substitution nobody is told
 * about is how `--live` becomes a second offline mode with a different stub.
 */

import type { BarContext } from "../types.ts";
import { baseEnv } from "./proc.ts";

export interface RealFleet {
  usable: string[];
  /** The operator's own PATH: whatever they really have installed. */
  env: Record<string, string>;
}

/** Ask the artifact under test which agents this machine can actually drive. */
export async function detectRealFleet(ctx: BarContext, timeoutMs = 180_000): Promise<RealFleet> {
  const result = await ctx.run(["detect", "--json", "--timeout", "30000"], { timeoutMs });
  const usable: string[] = [];
  try {
    const start = result.stdout.indexOf("[");
    const rows = start === -1 ? [] : (JSON.parse(result.stdout.slice(start)) as Array<{ id?: string; availability?: string }>);
    for (const row of rows) if (row.availability === "usable" && row.id) usable.push(row.id);
  } catch {
    // A binary that cannot report its fleet has no fleet, for this purpose.
  }
  return { usable, env: baseEnv() };
}
