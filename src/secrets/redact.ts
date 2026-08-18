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
 *   builder — the last point before the bytes leave. That writer is `Sink` in
 *   `./sink.ts`, and `./audit.ts` is the full-tree gate that keeps it the only
 *   one. Nothing in THIS file writes anything: it holds the inventory and the
 *   encodings, and a caller that redacts here and writes elsewhere has already
 *   made v1's mistake.
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

/** The enumerated list, by name. There is no "everything else" member, and that is the honest limit. */
export type EncodingName = "literal" | "json-escaped" | "url-encoded" | "base64";

export interface EncodedForm {
  readonly name: EncodingName;
  readonly value: string;
}

/**
 * Every form a value can take on its way to a file, each carrying its name.
 *
 * Failure 2 is exactly this list being one item long. The set is enumerable and
 * finite, which is the whole reason this is tractable — and it is also the
 * boundary of the honest limit above: an encoding not listed here is not
 * covered, and there is no way to cover "all encodings".
 *
 * The NAME is carried because a leak report that prints the pattern it matched
 * prints the secret, which is v1's failure wearing a hat. `leakEncodings` below
 * reports names; `leaks` reports patterns and is for tests only.
 */
export function encodedForms(value: string): EncodedForm[] {
  // First name wins on collision: a value whose escaped form equals its literal
  // is one needle, not two, and calling it "literal" is the truthful label.
  const byValue = new Map<string, EncodingName>();
  const add = (name: EncodingName, form: string): void => {
    if (!byValue.has(form)) byValue.set(form, name);
  };
  add("literal", value);
  // What a JSON serialiser would write between the quotes.
  add("json-escaped", JSON.stringify(value).slice(1, -1));
  try {
    add("url-encoded", encodeURIComponent(value));
  } catch {
    // Lone surrogates. The literal form is still covered.
  }
  try {
    add("base64", btoa(value));
  } catch {
    // Non-latin1. Same.
  }
  return [...byValue]
    .filter(([form]) => form.length >= MINIMUM_SECRET_LENGTH)
    .map(([form, name]) => ({ name, value: form }));
}

export function encodings(value: string): string[] {
  return encodedForms(value).map((form) => form.value);
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
    return this.forms().map((form) => form.value);
  }

  /** The same list, named, longest first. */
  forms(): EncodedForm[] {
    const byValue = new Map<string, EncodingName>();
    for (const form of [...this.#values].flatMap(encodedForms)) {
      if (!byValue.has(form.value)) byValue.set(form.value, form.name);
    }
    return [...byValue]
      .map(([value, name]) => ({ name, value }))
      .sort((a, b) => b.value.length - a.value.length);
  }

  /**
   * How many trailing bytes of a stream must be held back before a flush is
   * safe.
   *
   * Rule 2 is "after composition", and a stream is composed across CALLS. A
   * sink that flushes at every newline is composing correctly for every pattern
   * that cannot contain a newline — which is all of them unless an inventoried
   * value has one, and a PEM key does. So: zero when no pattern spans lines,
   * and otherwise one byte short of the longest pattern, which is the largest
   * tail a pattern can straddle into.
   */
  straddleGuard(): number {
    let longest = 0;
    for (const pattern of this.patterns()) {
      if (pattern.includes("\n") && pattern.length > longest) longest = pattern.length;
    }
    return longest === 0 ? 0 : longest - 1;
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

  /**
   * The same question, answered without quoting the answer.
   *
   * `leaks` returns the PATTERNS it matched, which are the secrets — fine in a
   * test that already holds them, and a leak channel anywhere else. This
   * returns encoding names, so a caller can report "the record held the
   * base64 form" into a file that goes through the sink without the report
   * itself being the leak.
   */
  leakEncodings(text: string): EncodingName[] {
    const hit = new Set<EncodingName>();
    for (const form of this.forms()) {
      if (text.includes(form.value)) hit.add(form.name);
    }
    return [...hit];
  }
}
