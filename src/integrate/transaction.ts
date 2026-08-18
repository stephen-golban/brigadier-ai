// SPDX-License-Identifier: Apache-2.0
/**
 * One transaction, or none of it.
 *
 * Ruling 51 publishes a wave with a single `git update-ref --stdin`, and v1 was
 * right about why. MEASURED against `git 2.50.1` on 2026-08-17
 * (`probes/integration.sh` check 4, re-measured here): a batch containing one
 * good `create` and one entry that could not be applied left the GOOD entry
 * unapplied too. Publishing N item refs plus a branch is exactly the moment a
 * crash or a lost race leaves half a run behind — half a run being the state
 * from which nobody can tell what happened.
 *
 * WHAT IS IN THE BATCH, and why the item refs are in it at all:
 *
 *   - a `verify` for every item ref this wave read, pinned to the sha the merge
 *     was computed from. The refs already exist by then — ruling 56 requires
 *     the fetch to happen BEFORE the ownership diff, and the ownership diff
 *     before the merge — so what the transaction adds is the assertion that
 *     they have not moved since. "The branch exists" and "these exact item refs
 *     are what it was built from" become one atomic fact instead of two facts
 *     with a window between them.
 *   - a `create` (wave 1) or a compare-and-swap `update` (wave N+1) of
 *     `refs/heads/brigadier/<run-id>`.
 *
 * MEASURED against `git 2.50.1` on 2026-08-17: a batch of `create <new ref>`
 * plus `verify <existing ref> <wrong sha>` exited 128 with
 * `cannot lock ref … is at <x> but expected <y>`, and the new ref was NOT
 * created. That is the negative control for this module, and it is the same
 * shape as the ruling's own.
 *
 * The `-z` form is used rather than the line form because the line form has
 * quoting rules for refs containing unusual bytes, and a ref name arriving from
 * a run id is a ref name arriving from an argument.
 */

import { allowedEnv } from "../isolation/internal-git.ts";
import { REF_NAMESPACE, integrationBranch } from "../repo/refs.ts";
import { parentGit } from "./parent.ts";

export type RefEntry =
  /** Fails if the ref already exists — which is how brigadier never clobbers a branch. */
  | { kind: "create"; ref: string; value: string }
  /** Compare-and-swap. `old` is not optional, for `deleteRefArgv`'s reason. */
  | { kind: "update"; ref: string; value: string; old: string }
  /** Assert without changing. The batch fails, whole, if the ref has moved. */
  | { kind: "verify"; ref: string; value: string };

export class RefRefused extends Error {
  constructor(message: string) {
    super(`rulings 50 and 51: ${message}`);
    this.name = "RefRefused";
  }
}

const OID = /^[0-9a-f]{40,64}$/;

/**
 * A run may write two kinds of ref and no third.
 *
 * `refs/brigadier/<run-id>/…` is the invisible machinery, and
 * `refs/heads/brigadier/<run-id>` is the deliverable — the only ref brigadier
 * makes visible, and the only one it never deletes. Anything else in a batch is
 * a bug or an injection, and both fail here rather than in the operator's
 * repository. Ruling 50 gives refs their own rule precisely because ruling 15's
 * path-shaped ownership proofs cannot reach inside a `.git`.
 */
/**
 * The three commands a publish may use, checked at RUNTIME.
 *
 * The `RefEntry` union is a compile-time guard and a compile-time guard is no
 * guard at all against a cast, a caller in JavaScript, or a refactor that adds
 * a fourth kind. MEASURED against `git 2.50.1` on 2026-08-18: an entry
 * `{kind: "delete", ref: <integration branch>}` was emitted verbatim and git
 * applied it — the branch vanished from `git branch --list`. Ruling 51 makes
 * that branch the only ref brigadier never deletes, so the rule is enforced
 * here, beside the ownership check, rather than in the type system.
 */
const PUBLISH_COMMANDS: readonly string[] = ["create", "update", "verify"];

/**
 * A ref name brigadier is willing to build a transaction line out of.
 *
 * `refs/brigadier/<id>/../../heads/main` starts with the right prefix and names
 * something else entirely. git's own refname parser rejected it, so nothing
 * landed — but relying on the parser of the program you are trying to constrain
 * is luck, not a guard, and luck is what this rule exists instead of.
 */
const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function assertOwnedRef(ref: string, runId: string): void {
  if (!REF_SHAPE.test(ref) || ref.split("/").includes("..") || ref.includes("//")) {
    throw new RefRefused(`refusing a ref brigadier cannot vouch for the shape of: ${ref}`);
  }
  if (ref === integrationBranch(runId)) return;
  if (ref.startsWith(`${REF_NAMESPACE}/${runId}/`)) return;
  throw new RefRefused(
    `refusing to write ${ref} in the operator's repository. A run writes ` +
      `${REF_NAMESPACE}/${runId}/… for its machinery and ${integrationBranch(runId)} for its ` +
      "deliverable, and nothing else — not a branch of the operator's, not another run's refs.",
  );
}

/** Ruling 51: no publish deletes anything, and the deliverable least of all. */
export function assertPublishCommand(kind: string, ref: string, runId: string): void {
  if (PUBLISH_COMMANDS.includes(kind)) return;
  throw new RefRefused(
    `refusing a \`${kind}\` entry for ${ref} in a publish transaction. A publish creates, ` +
      "updates or verifies, and never deletes — and `refs/heads/brigadier/" +
      `${runId}\` is the one ref brigadier never deletes at all: it is the deliverable, and ` +
      "from the moment it exists it is the operator's. A ref delete is `deleteRefArgv`'s " +
      "compare-and-swap form, under ruling 50's rule, and it can never reach this ref.",
  );
}

/**
 * The `-z` stdin form: `<command> SP <ref> NUL [<newvalue> NUL] [<oldvalue> NUL]`.
 *
 * MEASURED against `git 2.50.1` on 2026-08-17 for `create` and `verify` in one
 * batch, and for `update` with an old value in `test/integrate.test.ts`'s
 * second wave.
 */
export function transactionStdin(entries: readonly RefEntry[], runId: string): string {
  if (entries.length === 0) throw new RefRefused("an empty ref transaction publishes nothing");
  let payload = "";
  for (const entry of entries) {
    // Runtime first, and both: a `delete` naming a ref this run owns is exactly
    // the shape that got through when only the type system was looking.
    assertPublishCommand((entry as { kind: string }).kind, entry.ref, runId);
    assertOwnedRef(entry.ref, runId);
    if (!OID.test(entry.value)) {
      throw new RefRefused(`refusing ${entry.kind} ${entry.ref} without a full sha: ${entry.value}`);
    }
    if (entry.kind === "update" && !OID.test(entry.old)) {
      throw new RefRefused(
        `refusing to update ${entry.ref} without the sha it is expected to be at. A ref that ` +
          "moved under brigadier means something it does not understand is happening in the " +
          "operator's repository, and the correct response is to report rather than to win.",
      );
    }
    payload += `${entry.kind} ${entry.ref}\0${entry.value}\0`;
    if (entry.kind === "update") payload += `${entry.old}\0`;
  }
  return payload;
}

export class TransactionFailed extends Error {
  constructor(
    readonly code: number,
    readonly stderr: string,
  ) {
    super(
      `ruling 51: the publish transaction failed (exit ${code}) and NOTHING was published — ` +
        `git said: ${stderr.trim()}`,
    );
    this.name = "TransactionFailed";
  }
}

/**
 * Apply the batch.
 *
 * This is the one git command in `src/integrate/` that is spawned here rather
 * than through `internal-git.ts`, for one reason: it needs stdin, and that
 * module's spawn is `stdin: "ignore"` by design. So the refusal it exists to
 * perform is asked for explicitly first — a trivial `rev-parse` through
 * `parentGit`, which throws `GitRefused` if `repo` is a clone this process
 * released or one any run manifest claims — and the environment for the spawn
 * is built with the same allowlist, so `GIT_CONFIG_COUNT` and friends cannot
 * arrive through the parent process's environment.
 */
export async function applyRefTransaction(
  repo: string,
  runId: string,
  entries: readonly RefEntry[],
): Promise<void> {
  const payload = transactionStdin(entries, runId);
  // Ruling 56's refusal, asked for rather than assumed. It runs BEFORE the
  // payload reaches git.
  await parentGit(repo, ["rev-parse", "--git-dir"]);

  const child = Bun.spawn([Bun.which("git") ?? "git", "update-ref", "-z", "--stdin"], {
    cwd: repo,
    stdin: new TextEncoder().encode(payload),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...allowedEnv(), GIT_TERMINAL_PROMPT: "0" },
  });
  const [, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  if (code !== 0) throw new TransactionFailed(code, stderr);
}
