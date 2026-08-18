// SPDX-License-Identifier: Apache-2.0
/**
 * The guard `src/queue/execute.ts` used to fail, with a file that trips it.
 *
 * Ruling 62b: every guard gets a demonstrated negative, because a check that
 * reports nothing looks exactly like a clean tree. The guard here is ruling 65's
 * second rule — **one sink, AFTER composition** — and this file shows the two
 * ways the deleted `redactEvent` broke it, each written twice: once around the
 * sink, where the secret reaches the file, and once through it, where it does
 * not.
 *
 * `redactEvent` was:
 *
 *     for (const [key, value] of Object.entries(event))
 *       redacted[key] = typeof value === "string" ? inventory.redact(value) : value;
 *     return JSON.stringify(redacted);
 *
 * It calls the redactor. Every field it touches comes back clean. And it is
 * still v1's failure 2 and failure 3, because redaction ran on the PIECES and
 * the file gets the WHOLE:
 *
 *   1. a value spanning the `<path>: <cause>` join is in neither piece, so a
 *      caller that redacts BOTH pieces and then composes them writes the secret
 *      out having called the redactor twice and been told it was clean twice;
 *   2. a value nested inside an object or an array is not a top-level string,
 *      so the loop never looks at it at all.
 *
 * Every assertion below is on THE BYTES ON DISK — `readFileSync` of the file
 * that was actually written — and never on a flag the code returned. v1's
 * assertion *"the output does not contain the secret"* was true of a file that
 * contained it, so a test that trusts a return value repeats the bug it is
 * checking for.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendEvent, type RunEvent } from "../src/run/record.ts";
import { SecretInventory } from "../src/secrets/redact.ts";
import { Sink } from "../src/secrets/sink.ts";

const ROOT = mkdtempSync(join(homedir(), ".brigadier-sink-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("a secret spanning a `<path>: <cause>` join", () => {
  // The two halves are what the two variables actually hold — a clone path and
  // a git error — and the secret is only present once they are joined by the
  // `: ` that composes a diagnostic. This is not contrived: a token embedded in
  // a remote URL splits exactly here.
  const head = "https://x-access-token";
  const tail = "9f3ac41e@github.com/acme/private.git";
  const secret = `${head}: ${tail}`;

  const inventory = new SecretInventory().add(secret);
  const event = (detail: string): RunEvent => ({
    type: "check-settled",
    at: 1,
    item: 1,
    check: "integrate item 1",
    outcome: "fail",
    detail,
  });

  test("NEGATIVE CONTROL: neither piece contains the secret, so field-wise redaction has nothing to find", () => {
    // Without this, "the redactor missed it" would be indistinguishable from
    // "the redactor was never given the value".
    expect(inventory.leaks(head)).toEqual([]);
    expect(inventory.leaks(tail)).toEqual([]);
    expect(inventory.leaks(`${head}: ${tail}`)).toEqual([secret]);
  });

  test("WRITTEN AROUND THE SINK: the secret reaches the record's bytes on disk", () => {
    // A DILIGENT caller: it redacts every value it holds, and only then
    // composes the diagnostic. Both calls come back clean, because neither
    // value contains the secret — the secret is the `: ` between them, and it
    // does not exist until after the last redaction has run.
    const path = join(ROOT, "around-join.ndjson");
    const composed = `${inventory.redact(head)}: ${inventory.redact(tail)}`;
    appendEvent(path, event(composed));
    const bytes = readFileSync(path, "utf8");
    expect(bytes).toContain(secret);
    expect(bytes).not.toContain("[redacted]");
  });

  test("WRITTEN THROUGH THE SINK: it does not", () => {
    const path = join(ROOT, "through-join.ndjson");
    const sink = new Sink(inventory);
    sink.append(path, JSON.stringify(event(`${head}: ${tail}`)));
    const bytes = readFileSync(path, "utf8");
    expect(bytes).not.toContain(secret);
    expect(bytes).toContain("[redacted]");
    // Still one whole event per line, and still valid JSON: redacting the
    // composed line must not cost the record its parseability.
    const lines = bytes.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { detail: string }).detail).toBe("[redacted]");
  });

  test("and every encoding of it is gone, checked against the file, not a flag", () => {
    const bytes = readFileSync(join(ROOT, "through-join.ndjson"), "utf8");
    for (const form of [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      Buffer.from(secret, "utf8").toString("base64"),
    ]) {
      expect(bytes).not.toContain(form);
    }
  });
});

describe("a secret nested below the top level of the document", () => {
  const secret = "sk-live-7f2b91d4c6a8";
  const inventory = new SecretInventory().add(secret);
  // The shape `record.json` actually has: run-level strings at the top, and the
  // checker's own words several levels down inside an array of objects.
  const document = () => ({
    runId: "r1",
    runRoot: "/home/x/.brigadier",
    items: [{ id: "a", checks: [{ name: "worker", outcome: "error", detail: `codex exited 1: ${secret}` }] }],
  });

  test("WRITTEN AROUND THE SINK: a top-level field loop never looks at it", () => {
    const path = join(ROOT, "around-nested.json");
    const shallow: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(document())) {
      shallow[key] = typeof value === "string" ? inventory.redact(value) : value;
    }
    writeFileSync(path, `${JSON.stringify(shallow, null, 2)}\n`);
    expect(readFileSync(path, "utf8")).toContain(secret);
  });

  test("WRITTEN THROUGH THE SINK: composition first, redaction on the final bytes", () => {
    const path = join(ROOT, "through-nested.json");
    const sink = new Sink(inventory);
    sink.write(path, `${JSON.stringify(document(), null, 2)}\n`);
    const bytes = readFileSync(path, "utf8");
    expect(bytes).not.toContain(secret);
    expect(bytes).toContain("[redacted]");
    // NEGATIVE CONTROL: the sink redacts an inventoried value and nothing else.
    // A sink that blanked everything would satisfy the line above and destroy
    // every diagnostic in the file.
    expect(bytes).toContain("codex exited 1:");
    expect(bytes).toContain("/home/x/.brigadier");
  });
});

describe("the stream, which is composed across CALLS", () => {
  const secret = "sk-live-7f2b91d4c6a8";

  test("WRITTEN AROUND THE SINK: two writes, each redacted, each clean, and the stream is not", () => {
    // v1's failure 3 verbatim: neither write contains the whole thing, so a
    // per-write redactor has nothing to match and the terminal gets the secret.
    const inventory = new SecretInventory().add(secret);
    const written: string[] = [];
    for (const chunk of ["worker said sk-live-", "7f2b91d4c6a8 and stopped\n"]) written.push(inventory.redact(chunk));
    expect(written.join("")).toContain(secret);
  });

  test("WRITTEN THROUGH THE SINK: the same two writes, and it is not there", () => {
    const inventory = new SecretInventory().add(secret);
    const written: string[] = [];
    const sink = new Sink(inventory, { out: (chunk) => written.push(chunk), err: () => {} });
    sink.out("worker said sk-live-");
    sink.out("7f2b91d4c6a8 and stopped\n");
    sink.end();
    expect(written.join("")).not.toContain(secret);
    expect(written.join("")).toContain("[redacted]");
  });

  test("NEGATIVE CONTROL: end() is what flushes the tail, so it is not optional", () => {
    // The last fragment is held back precisely because a pattern could straddle
    // it. A caller that exits without `end()` loses it — which is why `src/cli.ts`
    // calls `end()` before every exit including the re-raise.
    const inventory = new SecretInventory().add("-----BEGIN KEY-----\nabcdefghijkl\n-----END KEY-----");
    const written: string[] = [];
    const sink = new Sink(inventory, { out: (chunk) => written.push(chunk), err: () => {} });
    sink.out("a trailing fragment with no newline");
    expect(written.join("")).not.toContain("fragment");
    sink.end();
    expect(written.join("")).toContain("a trailing fragment with no newline");
  });
});
