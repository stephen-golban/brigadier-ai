// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 65, with v1's three measured redaction failures written as tests.
 *
 * Each of them shipped. Each passed the obvious assertion at the time.
 */

import { describe, expect, test } from "bun:test";
import {
  MINIMUM_SECRET_LENGTH,
  PLACEHOLDER,
  SecretInventory,
  encodings,
} from "../src/secrets/redact.ts";

describe("failure 1 — two sources of truth, and a rotated secret in cleartext", () => {
  test("a rotated-away value is still redacted", () => {
    const inv = new SecretInventory().add("sk-old-value-aaaaaaaa");
    // Rotation mid-run. The old value must not stop being a secret.
    inv.add("sk-new-value-bbbbbbbb");
    expect(inv.redact("token=sk-old-value-aaaaaaaa")).toBe(`token=${PLACEHOLDER}`);
    expect(inv.redact("token=sk-new-value-bbbbbbbb")).toBe(`token=${PLACEHOLDER}`);
  });

  test("the inventory is append-only — there is no way to shrink it", () => {
    const inv = new SecretInventory().add("sk-aaaaaaaaaaaa");
    expect(inv.size).toBe(1);
    // No `remove`, no `clear`, no `set`. Failure 1 was a second inventory
    // rebuilt from current file contents; there is nowhere to put one.
    expect("remove" in inv).toBe(false);
    expect("clear" in inv).toBe(false);
  });
});

describe("failure 2 — redacting a rendering let the escaped form through", () => {
  // The secret contains a quote, so a JSON serialiser escapes it.
  const secret = 'sk-live-"quoted"-aaaa';
  const inv = new SecretInventory().add(secret);

  test("the escaped form is redacted, not just the literal", () => {
    const serialised = JSON.stringify({ token: secret });
    // THE V1 ASSERTION, which passed while the file still held the secret:
    expect(serialised.includes(secret)).toBe(false);
    // ...and here is what it missed.
    expect(inv.leaks(serialised).length).toBeGreaterThan(0);
    expect(inv.redact(serialised)).not.toContain('\\"quoted\\"');
    expect(inv.leaks(inv.redact(serialised))).toEqual([]);
  });

  test("url-encoded and base64 forms are covered too", () => {
    const plain = "sk-live-token-with-slash/and+plus";
    const inv2 = new SecretInventory().add(plain);
    for (const form of [encodeURIComponent(plain), btoa(plain)]) {
      expect(inv2.leaks(`payload=${form}`).length).toBeGreaterThan(0);
      expect(inv2.leaks(inv2.redact(`payload=${form}`))).toEqual([]);
    }
  });

  test("`encodings` returns the literal plus the transformed forms", () => {
    expect(encodings(secret)).toContain(secret);
    expect(encodings(secret).length).toBeGreaterThan(1);
  });
});

describe("failure 3 — a secret spanning a join, redacted as fragments", () => {
  const secret = "sk-spanning-the-join-aaaa";
  const inv = new SecretInventory().add(secret);

  test("redacting the halves separately misses it — the bug, reproduced", () => {
    const left = "config/sk-spanning";
    const right = "the-join-aaaa: not found";
    // Each half is clean on its own. This is why v1's per-fragment redaction
    // reported success.
    expect(inv.leaks(left)).toEqual([]);
    expect(inv.leaks(right)).toEqual([]);
    // But the composition is not.
    const joined = `${left}-${right}`;
    expect(joined).toContain(secret);
    expect(inv.leaks(joined).length).toBeGreaterThan(0);
  });

  test("redacting AFTER composition catches it", () => {
    const joined = `config/sk-spanning-the-join-aaaa: not found`;
    expect(inv.leaks(inv.redact(joined))).toEqual([]);
  });
});

describe("the standing ruling: a path is not a secret", () => {
  test("a branch slug survives redaction", () => {
    const inv = new SecretInventory().add("sk-live-aaaaaaaaaaaa");
    const line = "refs/heads/brigadier/2026-08-17.a1b2 — 3 items landed";
    // Adopting "paths are secret" forces redacting the slug out of branch names
    // and destroys diagnostics.
    expect(inv.redact(line)).toBe(line);
  });

  test("short values are not inventoried at all", () => {
    const inv = new SecretInventory().add("dev");
    expect(inv.size).toBe(0);
    // Otherwise every occurrence of a three-letter string vanishes from the
    // record, which destroys more than it protects.
    expect(inv.redact("the dev server")).toBe("the dev server");
    expect(MINIMUM_SECRET_LENGTH).toBeGreaterThan(3);
  });
});

describe("overlapping values", () => {
  test("the longer secret wins, so no fragment of it survives", () => {
    const inv = new SecretInventory().add("sk-prefix-aaaa", "sk-prefix-aaaa-and-more");
    const out = inv.redact("token=sk-prefix-aaaa-and-more");
    expect(out).toBe(`token=${PLACEHOLDER}`);
    expect(inv.leaks(out)).toEqual([]);
  });
});
