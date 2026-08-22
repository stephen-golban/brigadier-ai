// SPDX-License-Identifier: Apache-2.0
/**
 * D24's line form, and ruling 80's fourth audience.
 *
 * The interesting property is the REFUSAL. A flattening `say()` would satisfy
 * every "is it one line" assertion while keeping the paragraph — the line form
 * would then bound the shape of the output and nothing about what is in it,
 * which is precisely the failure a word list has. So the test that matters is
 * that a multi-line fact does not get through at all.
 */

import { describe, expect, test } from "bun:test";
import { NotOneLine, QUOTE_WIDTH, SPEAKER, quote, say } from "../src/report/say.ts";
import { hasInFlightDisplay, inFlightShape, isCapped, type Audience } from "../src/report/budget.ts";

describe("D24: one fact, one line", () => {
  test("a fact comes back in brigadier's voice, on one line", () => {
    expect(say("planning → claude")).toBe("brigadier: planning → claude");
    expect(say("item 3 done").split("\n")).toHaveLength(1);
    expect(say("x").startsWith(SPEAKER)).toBe(true);
  });

  test("A MULTI-LINE FACT IS REFUSED, not flattened", () => {
    // The whole mechanism. Flattening would keep the paragraph and hide it;
    // refusing makes the author pick the fact that is worth a line.
    expect(() => say("planning\nand also researching")).toThrow(NotOneLine);
    expect(() => say("done\r\nfinished")).toThrow(NotOneLine);
    // And it says how many lines it got, so the author can see what they wrote.
    try {
      say("a\nb\nc");
    } catch (error) {
      expect((error as Error).message).toContain("and this one is 3");
      expect((error as Error).message).toContain("quote()");
    }
  });

  test("the negative control: an ordinary fact does NOT throw", () => {
    expect(() => say("plan ready → /tmp/r/1/plan.json")).not.toThrow();
  });
});

describe("quoting somebody else's prose, which D24 says cannot be shaped", () => {
  test("newlines collapse and the words survive in their own order", () => {
    const worker = "The test suite failed.\n\n  Two assertions in auth.test.ts\nare red.";
    const quoted = quote(worker);
    expect(quoted.split("\n")).toHaveLength(1);
    expect(quoted).toBe("The test suite failed. Two assertions in auth.test.ts are red.");
  });

  test("it is bounded, and the truncation SAYS it truncated", () => {
    const long = "x".repeat(QUOTE_WIDTH + 50);
    const quoted = quote(long);
    expect(quoted.length).toBeLessThan(long.length);
    expect(quoted).toContain("… [cut]");
  });

  test("it never paraphrases: every surviving byte is the worker's own", () => {
    const worker = "reviewer says: the retry loop can spin forever when the vendor returns 429";
    expect(quote(worker)).toBe(worker);
  });

  test("a quoted paragraph can be said, which is the point of having both", () => {
    expect(() => say(quote("two\nlines"))).not.toThrow();
    expect(say(quote("two\nlines"))).toBe("brigadier: two lines");
  });
});

describe("ruling 80's fourth audience", () => {
  const ALL: Audience[] = ["terminal", "acp-client", "host-session", "watched-session"];

  test("a human watching a session a model is also in is its own state", () => {
    expect(ALL).toContain("watched-session");
  });

  test("it is CAPPED, because a human watching does not make the window cheaper", () => {
    expect(isCapped("watched-session")).toBe(true);
    expect(isCapped("host-session")).toBe(true);
    // The two that pay nothing are the two that are not capped.
    expect(isCapped("terminal")).toBe(false);
    expect(isCapped("acp-client")).toBe(false);
  });

  test("in-flight output is CHUNKED there — named as unmeasured, not invented", () => {
    expect(inFlightShape("watched-session")).toBe("chunked");
    expect(inFlightShape("terminal")).toBe("stream");
    expect(inFlightShape("acp-client")).toBe("stream");
    // And a session no human is watching still gets nothing, which is the half
    // of ruling 58 that was right.
    expect(inFlightShape("host-session")).toBe("none");
    expect(hasInFlightDisplay("host-session")).toBe(false);
  });

  test("every audience answers both questions — a new state cannot be half-added", () => {
    for (const audience of ALL) {
      expect(typeof isCapped(audience)).toBe("boolean");
      expect(["stream", "chunked", "none"]).toContain(inFlightShape(audience));
    }
  });
});
