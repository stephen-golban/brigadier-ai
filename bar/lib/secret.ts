// SPDX-License-Identifier: Apache-2.0
/**
 * Enumerated encodings of a granted secret, and the search for them.
 *
 * Ruling 65 defeats VERBATIM leaks only, and item 12 is written so that a reader
 * cannot conclude otherwise: a worker that paraphrases a key, re-encodes it in a
 * scheme not enumerated here, or describes it in prose is not caught by this
 * code or by the product.
 *
 * The second function is the one that makes the item worth running. v1's
 * assertion was "does the raw literal appear?", and it PASSED on a file that
 * still held the secret in escaped form. Both assertions are run and both
 * results printed, so the item cannot quietly become v1's again.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listTree } from "./fs.ts";

export interface Encoding {
  name: string;
  value: string;
}

export function encodings(secret: string): Encoding[] {
  return [
    { name: "literal", value: secret },
    // `JSON.stringify` quotes as well as escapes; the quotes are stripped so the
    // needle is the escaped BODY, which is what lands inside a larger document.
    { name: "json-escaped", value: JSON.stringify(secret).slice(1, -1) },
    { name: "url-encoded", value: encodeURIComponent(secret) },
    { name: "base64", value: Buffer.from(secret, "utf8").toString("base64") },
  ];
}

export interface Leak {
  file: string;
  encoding: string;
}

/** Every file under `root` holding the secret in any enumerated encoding. */
export function scanForSecret(root: string, secret: string): Leak[] {
  const found: Leak[] = [];
  const needles = encodings(secret);
  for (const rel of listTree(root)) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), "latin1");
    } catch {
      continue;
    }
    for (const needle of needles) {
      if (needle.value.length > 0 && text.includes(needle.value)) found.push({ file: rel, encoding: needle.name });
    }
  }
  return found;
}

/** v1's assertion, kept so the two can be printed side by side. */
export function scanForLiteralOnly(root: string, secret: string): Leak[] {
  return scanForSecret(root, secret).filter((l) => l.encoding === "literal");
}

export function makeSecret(): string {
  // Deliberately full of characters the four encodings disagree about, so
  // "literal" and "json-escaped" are genuinely different needles.
  return `bar-secret-${Math.random().toString(36).slice(2, 10)}/+="\\\n`;
}
