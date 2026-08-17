// SPDX-License-Identifier: Apache-2.0
/**
 * Redaction, and the three v1 failures it exists to make impossible.
 *
 * Ruling 65. Like the three gate failures in #8, these look like three bugs and
 * are three faces of one: **redaction was applied at the wrong point in the
 * pipeline** — after a transformation, before a composition, or against a set of
 * values computed at a different time from the one being written.
 *
 *   1. TWO SOURCES OF TRUTH. One inventory rebuilt from the current contents of
 *      the secret files, another accumulating rotated-away values. A secret
 *      rotated mid-run reached the run record in cleartext.
 *
 *   2. REDACTING A RENDERING. Redacting `JSON.stringify`'s output for the
 *      literal value found nothing, because the serialiser had escaped it — so
 *      the obvious assertion ("the output does not contain the secret") passed
 *      on a file that still contained it, in escaped form.
 *
 *   3. REDACTING FRAGMENTS. A secret spanning a `"<path>: <cause>"` join
 *      survived, because the two halves were redacted separately and neither
 *      half contained the whole thing.
 *
 * So three rules, one per failure, and each is a property of WHERE redaction
 * happens rather than of how clever the matching is:
 *
 *   ONE INVENTORY, APPEND-ONLY, NEVER RECOMPUTED. A value that was ever a
 *   secret stays one for the life of the run. Rotation adds; it never removes.
 *
 *   ONE SINK, AFTER COMPOSITION. Every persisted artifact and every stream out
 *   of brigadier passes through a single writer, and that writer redacts the
 *   final bytes. Not the serialiser, not the log formatter, not a string
 *   builder — the last point before the bytes leave.
 *
 *   EVERY ENCODING, NOT THE LITERAL. A secret that survived `JSON.stringify` is
 *   still a leak.
 *
 * THE STANDING RULING, PRESERVED: **a path is not a secret; an inventoried
 * value is.** Adopting "paths are secret" forces redacting the slug out of
 * branch names and destroys diagnostics.
 *
 * HONEST LIMIT, kept from v1 and stated loudly rather than buried: this defeats
 * VERBATIM leaks only. A model that paraphrases a key, re-encodes it in a scheme
 * we do not enumerate, or describes it in prose is not caught by anything here.
 */

/** Below this, redaction destroys more than it protects. A 3-character "secret" is not one. */
export const MINIMUM_SECRET_LENGTH = 8;

export const PLACEHOLDER = "[redacted]";

/**
 * Every form a value can take on its way to a file.
 *
 * Failure 2 is exactly this list being one item long. The set is enumerable and
 * finite, which is the whole reason this is tractable — and it is also the
 * boundary of the honest limit above: an encoding not listed here is not
 * covered, and there is no way to cover "all encodings".
 */
export function encodings(value: string): string[] {
  const forms = new Set<string>([value]);
  // What a JSON serialiser would write between the quotes.
  forms.add(JSON.stringify(value).slice(1, -1));
  try {
    forms.add(encodeURIComponent(value));
  } catch {
    // Lone surrogates. The literal form is still covered.
  }
  try {
    forms.add(btoa(value));
  } catch {
    // Non-latin1. Same.
  }
  return [...forms].filter((form) => form.length >= MINIMUM_SECRET_LENGTH);
}

/**
 * The inventory. Append-only by construction — there is deliberately no
 * `remove`, and `add` is the only mutator.
 *
 * Failure 1 was two of these disagreeing. There is one, it is never rebuilt
 * from the current contents of anything, and a rotated value stays in it.
 */
export class SecretInventory {
  readonly #values = new Set<string>();

  add(...values: string[]): this {
    for (const value of values) {
      if (value.length >= MINIMUM_SECRET_LENGTH) this.#values.add(value);
    }
    return this;
  }

  get size(): number {
    return this.#values.size;
  }

  /** Every encoding of every value, longest first so a superstring wins. */
  patterns(): string[] {
    const all = [...this.#values].flatMap(encodings);
    return [...new Set(all)].sort((a, b) => b.length - a.length);
  }

  /**
   * The sink. Ruling 65: this is the ONLY place redaction happens, and it runs
   * on composed bytes rather than on fragments — which is what kills failure 3.
   */
  redact(text: string): string {
    let out = text;
    for (const pattern of this.patterns()) {
      out = out.split(pattern).join(PLACEHOLDER);
    }
    return out;
  }

  /**
   * Does this text still contain a secret in ANY encoding?
   *
   * Exists because failure 2 was an assertion that checked one encoding and
   * passed on a file that still held the secret. A verification helper that
   * repeats the bug is worse than none.
   */
  leaks(text: string): string[] {
    return this.patterns().filter((pattern) => text.includes(pattern));
  }
}
