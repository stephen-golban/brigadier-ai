// SPDX-License-Identifier: Apache-2.0
/**
 * The brief a worker is given, and the two properties of it that are rulings
 * rather than style.
 *
 * **Byte-identical across agents (ruling 16).** The same item produces the same
 * bytes whichever vendor runs it. Not "equivalent", not "the same information" —
 * the same bytes, so that a re-run on a different rung is comparing the work
 * rather than comparing two prompts.
 *
 * **A byte-stable PREFIX (ruling 21).** Everything constant comes first and
 * everything item-specific comes second, because ruling 21 recorded a 16.5×
 * prompt-cache lever on a stable prefix. Stated exactly as ruling 70 requires:
 * that is a lever this brief is SHAPED for, and brigadier cannot observe
 * whether any vendor cached it — three of six agents emit no usage at all
 * (#46) — so nothing here is a claim about what a run cost.
 *
 * **It says what the situation IS, not what the worker must not do.** Finding
 * 114's worker was following instructions it legitimately found on disk, and it
 * cost twelve minutes and zero files. Ruling 57 refuses the delegation at the
 * binary; this tells the worker why it will be refused, before it tries.
 *
 * THE COMMIT IS THE WORKER'S. Ruling 56 keeps brigadier's count of git commands
 * run inside a clone an agent has touched at zero, so brigadier cannot commit
 * on the worker's behalf — `integrateWave` fetches the clone's `work` branch and
 * an uncommitted change is not on it. That is why the instruction is explicit
 * and why it is in the prefix: it is the same for every item.
 */

import type { PlannedItem } from "./plan.ts";

/**
 * The constant half. Every byte of this is identical for every item, every
 * agent and every run — no run id, no path, no timestamp.
 */
export const BRIEF_PREFIX = `You are a brigadier worker.

This session IS the unit of work. Do the work yourself, here, in this directory.
Do not delegate it: \`brigadier\` refuses to orchestrate from inside a worker and
will exit non-zero if you invoke it, so an attempt costs a turn and produces
nothing.

Your working directory is a private clone. Nothing outside it is yours, and a
write outside it will be denied rather than silently dropped.

When the work is done, COMMIT IT on the current branch. brigadier reads your
result by fetching that branch; an uncommitted change is not part of your result
and will be reported as "changed no tracked file".

Ambient instruction files outside this directory — a user-global AGENTS.md, a
global conventions file, an installed plugin — are suppressed for this session
and do not apply. Anything load-bearing is below.

--- the task ---
`;

/** The item-specific half. Everything that varies lives here and only here. */
export function briefFor(item: PlannedItem): string {
  const lines = [
    `id: ${item.id}`,
    `kind: ${item.kind}`,
    item.kind === "write"
      ? `paths you own: ${item.paths.join(", ")}`
      : `paths you may read: ${item.paths.join(", ") || "the whole checkout"}`,
  ];
  if (item.kind === "write") {
    lines.push(
      "Writing outside the paths above rejects this item WHOLE at integration — not partially,",
      "and not with a warning. Ruling 51 does not merge a diff it cannot attribute.",
    );
  } else {
    lines.push(
      "This is a read-only item: your directory is never diffed, merged or read back, and your",
      "answer is the only output. Do not write files.",
    );
  }
  if (item.clampedTo !== null) {
    lines.push(
      item.clampedTo === item.difficulty
        ? `difficulty: ${item.difficulty}`
        : `difficulty: ${item.difficulty} (clamped to ${item.clampedTo} — brigadier only ever clamps down)`,
    );
  }
  if (item.verify.status === "resolved") {
    lines.push(`your work must pass: ${item.verify.argv.join(" ")}`);
  }
  lines.push("", item.prompt, "");
  return lines.join("\n");
}

/** Prefix plus task. The concatenation order is the cache lever. */
export function composeBrief(item: PlannedItem): string {
  return `${BRIEF_PREFIX}${briefFor(item)}`;
}
