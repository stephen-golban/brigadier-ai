// SPDX-License-Identifier: Apache-2.0
/**
 * Path containment: is this path inside the lane?
 *
 * `realpath` first, and on the deepest EXISTING ancestor, because a write
 * target does not exist yet and must still be judged on where it would actually
 * land. v1 shipped a containment escape here: `resolve()` collapses `..`
 * lexically, so a symlinked directory was never seen and `lane/link/../..`
 * resolved to somewhere it had no business being.
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

export class Containment {
  readonly root: string;

  constructor(root: string) {
    // Fail loudly rather than containing against a path that does not exist:
    // a lane rooted at a typo would accept nothing and look like a working guard.
    this.root = realpathSync(root);
  }

  /**
   * True when `candidate` resolves inside the lane root.
   *
   * A relative path is taken as relative to the lane, which is what every agent
   * means by one. An unresolvable path is NOT contained — the caller must not
   * be able to turn a broken path into an allowed write.
   */
  contains(candidate: string): boolean {
    if (!candidate) return false;

    const absolute = isAbsolute(candidate) ? candidate : join(this.root, candidate);

    // Walk up to the deepest ancestor that exists, remembering the tail, then
    // realpath the ancestor and re-attach. This is what makes a not-yet-created
    // file judgeable.
    let existing = absolute;
    const tail: string[] = [];
    while (!existsSync(existing)) {
      const parent = resolve(existing, "..");
      if (parent === existing) break;
      tail.unshift(existing.slice(parent.length + 1));
      existing = parent;
    }

    let real: string;
    try {
      real = realpathSync(existing);
    } catch {
      return false;
    }

    const full = tail.length > 0 ? join(real, ...tail) : real;
    return full === this.root || full.startsWith(this.root + sep);
  }

  /**
   * True when the path is inside the clone's own `.git`.
   *
   * Decision 34: a clone's `.git` is a real directory inside the agent's cwd —
   * the property clones were chosen for — so an agent can write
   * `.git/hooks/pre-commit` and brigadier's own next `git` call executes it with
   * the operator's privileges. Inside the lane, and still forbidden.
   */
  isGitInternal(candidate: string): boolean {
    if (!candidate) return false;
    const absolute = isAbsolute(candidate) ? candidate : join(this.root, candidate);
    const gitDir = join(this.root, ".git");
    return absolute === gitDir || absolute.startsWith(gitDir + sep);
  }
}
