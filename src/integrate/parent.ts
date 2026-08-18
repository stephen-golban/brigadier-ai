// SPDX-License-Identifier: Apache-2.0
/**
 * Every git command integration runs, runs HERE — in the operator's own
 * repository — and this module is the short list of what it may be.
 *
 * Ruling 51's promise is not "brigadier tries not to disturb your working
 * tree". It is that the disturbance is IMPOSSIBLE, because the whole
 * integration is `fetch`, `merge-tree --write-tree`, `commit-tree`,
 * `update-ref --stdin` and `diff --name-only`, and not one of those reads or
 * writes a working tree or an index. "Your working tree is where you left it"
 * stops being a promise kept carefully and becomes one that cannot be broken.
 *
 * A promise of that shape needs something to trip over, so the list of commands
 * that WOULD break it is written down and checked rather than remembered — the
 * same reasoning `scripts/forbidden-imports.ts` gives for its seams, and ruling
 * 57's classification: a rule nobody enforces is a request.
 *
 * Note what is deliberately NOT here: sanitisation. Ruling 56's invariant is
 * that brigadier runs no git command inside a clone an agent has touched, and
 * the operator's repository is the one place the ruling does not apply — a hook
 * in the operator's own repository runs with the operator's privileges, which
 * they already have. `src/isolation/base.ts` reaches the same conclusion for
 * the base state, and the two must not drift apart. What this module does is
 * make sure the command really is running in the operator's repository:
 * `internal-git.ts` refuses the call outright if the target is a clone this
 * process released or a clone any run manifest claims.
 */

import { git, runGit, type GitResult } from "../isolation/internal-git.ts";
import { FETCH_TRANSPORT_MUST_STAY } from "../repo/git.ts";

/**
 * The commands that would touch a working tree, an index or HEAD.
 *
 * `checkout` is the one the ruling names, and it is the one a future
 * "wouldn't it be simpler to just check out the branch and merge" would reach
 * for first. The rest are there because they are the same mistake wearing
 * different nouns — a guard that catches only the mistake somebody already made
 * is a guard that catches nothing.
 */
export const WORKING_TREE_COMMANDS: readonly string[] = [
  "checkout",
  "switch",
  "restore",
  "reset",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "am",
  "apply",
  "stash",
  "clean",
  "pull",
  "add",
  "commit",
  "mv",
  "rm",
];

export class WorkingTreeCommandRefused extends Error {
  constructor(readonly command: string) {
    super(
      `ruling 51: refusing to run \`git ${command}\` in the operator's repository. ` +
        "Integration is fetch, merge-tree --write-tree, commit-tree, update-ref --stdin and " +
        "diff --name-only — none of which reads or writes a working tree, an index or HEAD. " +
        "That is why the operator's tree cannot move during a run, and it is not a property " +
        "that survives one convenient exception.",
    );
    this.name = "WorkingTreeCommandRefused";
  }
}

/**
 * The first non-flag token of an argv, which is the git subcommand.
 *
 * Written out rather than `args[0]` because `-c foo=bar` and `--no-pager` are
 * legitimate leading tokens and a guard that only inspects position 0 is
 * bypassed by adding one.
 */
export function subcommandOf(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "-c" || token === "-C" || token === "--git-dir" || token === "--work-tree") {
      i++;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return null;
}

export function assertNoWorkingTreeCommand(args: readonly string[]): void {
  const command = subcommandOf(args);
  if (command !== null && WORKING_TREE_COMMANDS.includes(command)) {
    throw new WorkingTreeCommandRefused(command);
  }
}

/**
 * Ruling 51's transport, checked at the point of use.
 *
 * `src/repo/git.ts` carries `FETCH_TRANSPORT_MUST_STAY` so that a change has
 * something to trip over; this is the trip. MEASURED against `git 2.50.1` on
 * 2026-08-17 (`probes/base-state.sh`, `probes/git-exec.sh`, ruling 56):
 * `uploadpack.packObjectsHook` planted inside a clone did NOT fire when the
 * parent fetched the clone by filesystem path — because a local-path fetch does
 * not spawn `upload-pack` at all. That is a named condition, not a blank
 * cheque. A `file://` URL spawns `upload-pack` and the surface returns, so a
 * URL is refused here rather than accepted and hoped about.
 */
export function assertLocalPathTransport(source: string): void {
  if (FETCH_TRANSPORT_MUST_STAY !== "local-path") {
    throw new Error(
      `the fetch transport constant changed to ${FETCH_TRANSPORT_MUST_STAY}; ruling 51's ` +
        "measurement covers a local-path fetch only",
    );
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(source) || /^[^/\\]+@[^/\\]+:/.test(source)) {
    throw new Error(
      `ruling 51: refusing to fetch from ${source}. The measured fact is that a LOCAL-PATH ` +
        "fetch does not spawn upload-pack, which is why uploadpack.packObjectsHook planted " +
        "in a clone never fired. A URL — file:// included — spawns it, and hands an agent an " +
        "execution surface inside brigadier's own process tree. Pass the clone's path.",
    );
  }
}

/** Run git in the operator's repository. Throws on a non-zero exit. */
export async function parentGit(
  repo: string,
  args: readonly string[],
  env?: Record<string, string>,
): Promise<string> {
  assertNoWorkingTreeCommand(args);
  return git(env === undefined ? { cwd: repo, args: [...args] } : { cwd: repo, args: [...args], env });
}

/** The same, when a non-zero exit is information rather than a failure. */
export async function parentGitRaw(
  repo: string,
  args: readonly string[],
  env?: Record<string, string>,
): Promise<GitResult> {
  assertNoWorkingTreeCommand(args);
  return runGit(
    env === undefined ? { cwd: repo, args: [...args] } : { cwd: repo, args: [...args], env },
  );
}

/** Does this ref exist in the operator's repository? */
export async function refSha(repo: string, ref: string): Promise<string | null> {
  const result = await parentGitRaw(repo, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  return result.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}
