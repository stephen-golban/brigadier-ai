// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 65's second rule, with a demonstrated negative for every guard.
 *
 * Ruling 62b: a guard that always passes looks identical to a working one. So
 * every claim below is paired with the thing that WOULD have leaked — the
 * per-fragment redaction that v1 shipped, the literal-only assertion that
 * passed on a file holding the secret, the field-wise redaction that a
 * serialiser then escaped around. The pairing is the evidence; the passing half
 * on its own is a sentence.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRegularFile } from "../src/isolation/safe-fs.ts";
import { SecretInventory } from "../src/secrets/redact.ts";
import { Sink, SinkMisuse, type SinkStreams } from "../src/secrets/sink.ts";

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "brigadier-sink-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Capture extends SinkStreams {
  outText(): string;
  errText(): string;
}
function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    outText: () => out.join(""),
    errText: () => err.join(""),
  };
}

describe("failure 3 — a secret spanning a join, at the sink rather than at the fragments", () => {
  const secret = "sk-spanning-the-join-aaaa";
  const left = "config/sk-spanning";
  const right = "the-join-aaaa: not found";

  test("NEGATIVE CONTROL: redacting each half separately ships the whole secret", () => {
    const inv = new SecretInventory().add(secret);
    // This is v1. Both halves come back untouched, because neither contains the
    // value, and the composition that follows contains it in full.
    const composed = `${inv.redact(left)}-${inv.redact(right)}`;
    expect(composed).toContain(secret);
    expect(inv.leaks(composed).length).toBeGreaterThan(0);
  });

  test("the sink redacts the composed bytes, so the file does not hold it", () => {
    const sink = new Sink(new SecretInventory().add(secret), capture());
    const path = join(scratch(), "diagnostic.txt");
    sink.write(path, `${left}-${right}\n`);
    const written = readFileSync(path, "utf8");
    expect(written).not.toContain(secret);
    expect(sink.leaks(written)).toEqual([]);
    // The path itself is untouched: a path is not a secret.
    expect(written).toContain("config/");
  });

  test("NEGATIVE CONTROL: redacting each stream WRITE separately ships it too", () => {
    const inv = new SecretInventory().add(secret);
    const printed = `${inv.redact(left)}${inv.redact(`-${right}\n`)}`;
    expect(printed).toContain(secret);
  });

  test("the stream sink composes across calls and catches it", () => {
    const streams = capture();
    const sink = new Sink(new SecretInventory().add(secret), streams);
    sink.out(left);
    sink.out(`-${right}\n`);
    sink.end();
    expect(streams.outText()).not.toContain(secret);
    expect(streams.outText()).toContain("[redacted]");
  });

  test("NEGATIVE CONTROL: a redactor that walks an event's FIELDS misses everything else", () => {
    // This is the shape currently in `src/queue/execute.ts`: `Object.entries`,
    // redact the values that are strings, then hand the object to
    // `JSON.stringify`. It is v1's failure 3 with different scenery — a nested
    // object and an array are both "not a string" and are shipped whole.
    const secret = "sk-nested-value-aaaa";
    const event = { type: "check-settled", detail: { cause: secret }, tags: [secret] };
    const inv = new SecretInventory().add(secret);
    const fieldWise: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event)) {
      fieldWise[key] = typeof value === "string" ? inv.redact(value) : value;
    }
    const shipped = JSON.stringify(fieldWise);
    expect(shipped).toContain(secret);
    expect(inv.leaks(shipped).length).toBeGreaterThan(0);
  });

  test("the sink redacts the serialised line, so depth stops mattering", () => {
    const secret = "sk-nested-value-aaaa";
    const event = { type: "check-settled", detail: { cause: secret }, tags: [secret] };
    const sink = new Sink(new SecretInventory().add(secret), capture());
    const path = join(scratch(), "record.ndjson");
    sink.append(path, JSON.stringify(event));
    const written = readFileSync(path, "utf8");
    expect(written).not.toContain(secret);
    expect(sink.leaks(written)).toEqual([]);
    // One event, one line, and it still parses.
    expect(JSON.parse(written.trim())).toEqual({
      type: "check-settled",
      detail: { cause: "[redacted]" },
      tags: ["[redacted]"],
    });
  });
});

describe("failure 2 — every encoding, and v1's assertion run beside the real one", () => {
  // Characters the four encodings disagree about, so "literal" and
  // "json-escaped" are genuinely different needles rather than the same one
  // twice. Same construction BAR item 12 uses.
  const secret = 'sk-live-"quoted"/slash+plus-aaaa';

  test("the literal-only check PASSES on a file that holds the secret; the real one FAILS", () => {
    const dir = scratch();
    const bypass = join(dir, "bypassed.json");
    // Written AROUND the sink on purpose: this is the file v1 shipped.
    writeRegularFile(bypass, JSON.stringify({ token: secret }));
    const held = readFileSync(bypass, "utf8");

    // v1's assertion, verbatim. It passes.
    expect(held.includes(secret)).toBe(false);
    // The real one, on the same bytes. It fails, and names the encoding.
    const sink = new Sink(new SecretInventory().add(secret), capture());
    expect(sink.leaks(held)).toContain("json-escaped");
    expect(sink.leaks(held).length).toBeGreaterThan(0);
  });

  test("through the sink, both checks pass — and that is the only interesting case", () => {
    const sink = new Sink(new SecretInventory().add(secret), capture());
    const path = join(scratch(), "record.json");
    sink.write(path, JSON.stringify({ token: secret }, null, 2));
    const held = readFileSync(path, "utf8");
    expect(held.includes(secret)).toBe(false);
    expect(sink.leaks(held)).toEqual([]);
    // Still valid JSON: every enumerated form of a value containing a quote
    // carries that quote escaped, so no pattern can span a string delimiter.
    expect(JSON.parse(held)).toEqual({ token: "[redacted]" });
  });

  test("each of the four encodings is caught on disk, one at a time", () => {
    const plain = "sk-live-token-with-slash/and+plus";
    const inv = new SecretInventory().add(plain);
    const sink = new Sink(inv, capture());
    const dir = scratch();
    const forms: Array<[string, string]> = [
      ["literal", plain],
      ["json-escaped", JSON.stringify(plain).slice(1, -1)],
      ["url-encoded", encodeURIComponent(plain)],
      ["base64", btoa(plain)],
    ];
    for (const [name, form] of forms) {
      const bypass = join(dir, `bypass-${name}.txt`);
      writeRegularFile(bypass, `payload=${form}\n`);
      // NEGATIVE CONTROL: the encoding really is present and really is found.
      expect(sink.leaks(readFileSync(bypass, "utf8")).length).toBeGreaterThan(0);

      const sunk = join(dir, `sunk-${name}.txt`);
      sink.write(sunk, `payload=${form}\n`);
      expect(sink.leaks(readFileSync(sunk, "utf8"))).toEqual([]);
    }
  });

  test("the leak report names encodings and never quotes the secret", () => {
    // A leak report that prints what it matched is itself the leak.
    const sink = new Sink(new SecretInventory().add(secret), capture());
    const report = sink.leaks(JSON.stringify({ token: secret })).join(", ");
    expect(report.length).toBeGreaterThan(0);
    expect(report).not.toContain("sk-live");
  });
});

describe("failure 1 — one inventory, append-only, never recomputed", () => {
  test("a value rotated mid-run is still redacted at the sink afterwards", () => {
    const sink = new Sink(new SecretInventory().add("sk-old-value-aaaaaaaa"), capture());
    // Rotation. The new value is ADDED; nothing is dropped.
    sink.inventory.add("sk-new-value-bbbbbbbb");
    const path = join(scratch(), "after-rotation.txt");
    sink.write(path, "old=sk-old-value-aaaaaaaa new=sk-new-value-bbbbbbbb\n");
    const held = readFileSync(path, "utf8");
    expect(held).toBe("old=[redacted] new=[redacted]\n");
  });

  test("there is nowhere to put a second source of truth", () => {
    const sink = new Sink(new SecretInventory().add("sk-aaaaaaaaaaaa"), capture());
    expect("remove" in sink.inventory).toBe(false);
    expect("clear" in sink.inventory).toBe(false);
    // `add` is the only mutator, and it only ever grows.
    expect(sink.inventory.size).toBe(1);
    sink.inventory.add("sk-bbbbbbbbbbbb");
    expect(sink.inventory.size).toBe(2);
  });
});

describe("grant — delivery is environment injection, and the inventory happens in the same step", () => {
  test("a granted value is inventoried before it can be delivered", () => {
    const sink = new Sink(new SecretInventory(), capture());
    const grant = sink.grant(["TOKEN", "MISSING"], { TOKEN: "sk-granted-aaaaaaaa" });
    expect(grant.env).toEqual({ TOKEN: "sk-granted-aaaaaaaa" });
    expect(grant.inventoried).toEqual(["TOKEN"]);
    expect(grant.unset).toEqual(["MISSING"]);
    const path = join(scratch(), "granted.txt");
    sink.write(path, "value=sk-granted-aaaaaaaa\n");
    expect(readFileSync(path, "utf8")).toBe("value=[redacted]\n");
  });

  test("NEGATIVE CONTROL: a granted value under 8 characters is delivered and NOT redacted", () => {
    // The honest hole in `MINIMUM_SECRET_LENGTH`, demonstrated rather than
    // described. Redacting every occurrence of a three-character string
    // destroys more than it protects, so the floor stays and the operator is
    // told which names fell through it.
    const sink = new Sink(new SecretInventory(), capture());
    const grant = sink.grant(["SHORT"], { SHORT: "abc" });
    expect(grant.env).toEqual({ SHORT: "abc" });
    expect(grant.tooShort).toEqual(["SHORT"]);
    expect(grant.inventoried).toEqual([]);
    const path = join(scratch(), "short.txt");
    sink.write(path, "value=abc\n");
    expect(readFileSync(path, "utf8")).toBe("value=abc\n");
  });

  test("`grant` reports names, never values", () => {
    const sink = new Sink(new SecretInventory(), capture());
    const grant = sink.grant(["TOKEN"], { TOKEN: "sk-granted-aaaaaaaa" });
    expect(JSON.stringify({ ...grant, env: undefined })).not.toContain("sk-granted");
  });
});

describe("redaction is mandatory, and a path is not a secret", () => {
  test("an artifact is redacted whether or not this item was granted anything", () => {
    // The inventory can hold a value a worker reached some other way. There is
    // no flag on the sink, and no method that skips redaction.
    const sink = new Sink(new SecretInventory().add("sk-from-elsewhere-aaaa"), capture());
    const path = join(scratch(), "unrelated-item.txt");
    sink.write(path, "item 4 wrote sk-from-elsewhere-aaaa into its notes\n");
    expect(readFileSync(path, "utf8")).not.toContain("sk-from-elsewhere");
  });

  test("the branch ruling 51 makes the deliverable survives intact", () => {
    const streams = capture();
    const sink = new Sink(new SecretInventory().add("sk-live-aaaaaaaaaaaa"), streams);
    const line = "refs/heads/brigadier/2026-08-18.a1b2 — 3 items landed";
    sink.outLine(line);
    sink.end();
    expect(streams.outText()).toBe(`${line}\n`);
  });
});

describe("the stream sink holds back exactly what a pattern could straddle", () => {
  test("with no multi-line secret, a whole line is flushed immediately", () => {
    const streams = capture();
    const sink = new Sink(new SecretInventory().add("sk-live-aaaaaaaaaaaa"), streams);
    sink.outLine("first");
    // No `end()` yet: a line-oriented caller must not be made to wait.
    expect(streams.outText()).toBe("first\n");
    sink.end();
  });

  test("a multi-line secret split across two writes at a newline is still caught", () => {
    const secret = "-----BEGIN KEY-----\nsk-multi-line-aaaa\n-----END KEY-----";
    const inv = new SecretInventory().add(secret);
    // NEGATIVE CONTROL: flushing at the newline and redacting each flush — the
    // obvious implementation — ships it, because neither flush holds the whole.
    const naive = `${inv.redact("-----BEGIN KEY-----\n")}${inv.redact("sk-multi-line-aaaa\n-----END KEY-----\n")}`;
    expect(naive).toContain(secret);

    const streams = capture();
    const sink = new Sink(inv, streams);
    sink.out("-----BEGIN KEY-----\n");
    sink.out("sk-multi-line-aaaa\n-----END KEY-----\n");
    sink.end();
    expect(streams.outText()).not.toContain(secret);
  });

  test("`end` flushes the held tail and is idempotent", () => {
    const streams = capture();
    const sink = new Sink(new SecretInventory(), streams);
    sink.out("no trailing newline");
    expect(streams.outText()).toBe("");
    sink.end();
    sink.end();
    expect(streams.outText()).toBe("no trailing newline");
  });

  test("writing after `end` is refused rather than silently dropped", () => {
    const sink = new Sink(new SecretInventory(), capture());
    sink.end();
    expect(() => sink.out("late")).toThrow(SinkMisuse);
    expect(() => sink.write(join(scratch(), "late.txt"), "late")).toThrow(SinkMisuse);
  });

  test("stderr is redacted on its own buffer, not the shared one", () => {
    const streams = capture();
    const sink = new Sink(new SecretInventory().add("sk-live-aaaaaaaaaaaa"), streams);
    sink.errLine("failed: sk-live-aaaaaaaaaaaa");
    sink.outLine("ok");
    sink.end();
    expect(streams.errText()).toBe("failed: [redacted]\n");
    expect(streams.outText()).toBe("ok\n");
  });
});

describe("append — ruling 70's one event, one line", () => {
  test("a line containing a newline is refused, not split into two records", () => {
    const sink = new Sink(new SecretInventory(), capture());
    const path = join(scratch(), "record.ndjson");
    expect(() => sink.append(path, '{"a":1}\n{"b":2}')).toThrow(SinkMisuse);
  });

  test("a truncated tail is closed rather than fused with the next event", () => {
    const dir = scratch();
    const path = join(dir, "record.ndjson");
    // A record killed mid-line: no trailing newline.
    writeFileSync(path, '{"type":"run-started"}\n{"type":"clone-rec');
    const sink = new Sink(new SecretInventory(), capture());
    sink.append(path, '{"type":"item-landed"}');
    const lines = readFileSync(path, "utf8").split("\n");
    expect(lines[1]).toBe('{"type":"clone-rec');
    expect(lines[2]).toBe('{"type":"item-landed"}');
    expect(JSON.parse(lines[2]!)).toEqual({ type: "item-landed" });
  });

  test("appending through a symlink is refused, never repaired", () => {
    const dir = scratch();
    const outside = join(dir, "operator-file.txt");
    writeFileSync(outside, "the operator's file\n");
    const link = join(dir, "record.ndjson");
    symlinkSync(outside, link);
    const sink = new Sink(new SecretInventory(), capture());
    expect(() => sink.append(link, '{"type":"item-landed"}')).toThrow(SinkMisuse);
    expect(readFileSync(outside, "utf8")).toBe("the operator's file\n");
  });
});

describe("nothing hands the bytes back", () => {
  test("every writing method returns void, so a caller cannot take over the write", () => {
    // v1's shape was a redactor that RETURNED a redacted string for the caller
    // to print; the caller doing the printing is the bypass. There is no method
    // here whose value is bytes.
    const sink = new Sink(new SecretInventory().add("sk-live-aaaaaaaaaaaa"), capture());
    const path = join(scratch(), "returns.txt");
    expect(sink.write(path, "x")).toBeUndefined();
    expect(sink.append(join(scratch(), "r.ndjson"), "{}")).toBeUndefined();
    expect(sink.out("a\n")).toBeUndefined();
    expect(sink.err("a\n")).toBeUndefined();
    expect(sink.outLine("a")).toBeUndefined();
    expect(sink.errLine("a")).toBeUndefined();
    expect(sink.end()).toBeUndefined();
  });
});
