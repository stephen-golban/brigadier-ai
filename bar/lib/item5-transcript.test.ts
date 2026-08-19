// SPDX-License-Identifier: Apache-2.0
/**
 * Negative controls for the verifier's transcript recorder (ruling 62b).
 *
 * The recorder itself spends real vendor money and is never run here — nor by
 * item 5, nor by `bar/run.ts`. Everything below tests the pure half, which is
 * where its two promises live:
 *
 *   **it records and does not score** — asserted in BOTH directions, because the
 *   interesting one is the exemption. A reviewer that wrote "3 of 5" in its own
 *   answer must reach the verifier having written it, so the guard must not fire
 *   on verbatim material; and the harness's own voice must never contain a rate,
 *   so the guard must fire there. A guard that only ever passed would look
 *   identical to a working one;
 *
 *   **it hands over what a verifier who was not present needs** — the routing,
 *   the exact diff, the reviewer's full response, and the planted defects in the
 *   verifier's own words. Each is asserted by its CONTENT appearing in the
 *   artefact, never by a heading being present.
 */

import { describe, expect, test } from "bun:test";
import {
  SPEND_FLAG,
  VERIFIER_NEEDS,
  parseVerifierArgs,
  rateIn,
  renderTranscript,
  reviewerFrames,
  reviewerText,
  scoringIn,
  transcribePrompt,
  type Observations,
} from "./item5-verifier-transcript.ts";

const frame = (update: Record<string, unknown>): string =>
  JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update } });

const chunk = (text: string): string => frame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

const LOG = [
  `verifier out ${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt" })}`,
  `verifier in ${chunk("I am the BUILDER and must not appear in the reviewer's answer")}`,
  `verifier review out ${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt" })}`,
  `verifier review in ${chunk("The change drops the null check. ")}`,
  `verifier review in ${frame({ sessionUpdate: "tool_call", toolCallId: "t1", status: "completed" })}`,
  `verifier review in ${chunk("I found 3 of 5 things worth reporting.")}`,
  `other review in ${chunk("a different item's reviewer")}`,
].join("\n");

const OBS: Observations = {
  runId: "run-0007",
  binary: "dist/brigadier",
  repo: "/w/verifier-repo",
  itemId: "verifier",
  builderAgent: "codex",
  reviewerAgent: "claude",
  crossVendor: true,
  sameVendorReason: undefined,
  baseRef: "refs/brigadier/run-0007/base",
  baseSha: "a".repeat(40),
  itemRef: "refs/brigadier/run-0007/item/1",
  diffCommand: "git -C /w/verifier-repo diff aaa..refs/brigadier/run-0007/item/1",
  diff: "+++ b/src/candidate.ts\n+  return items[index + 1];\n",
  reviewerFrames: reviewerFrames(LOG, "verifier"),
  reviewerText: reviewerText(reviewerFrames(LOG, "verifier")),
  defects: "DEFECT 3: the loop reads one past the end. I planted it by hand on 2026-08-19.",
  prompt: transcribePrompt("defects/candidate.ts", "src/candidate.ts"),
  recordPath: "/w/runs/run-0007/record.jsonl",
  transcriptsPath: "/w/runs/run-0007/transcripts",
  exitCode: 1,
  stdout: "review:\n  CROSS-VENDOR — claude reviewed work built by codex\n",
  stderr: "",
};

describe("the recorder records and does not score", () => {
  test("the harness's own voice carries no rate, count or comparison", () => {
    expect(renderTranscript(OBS).scoring).toEqual([]);
  });

  test("NEGATIVE CONTROL: a rate in the harness's own voice is refused", () => {
    const scored = renderTranscript({ ...OBS, sameVendorReason: "only one vendor, so the catch rate is 0 of 5" });
    expect(scored.scoring.length).toBeGreaterThan(0);
    expect(scored.scoring).toContain("a catch rate");
  });

  test("NEGATIVE CONTROL: each scoring shape is recognised on its own", () => {
    expect(scoringIn("catch rate 3 of 5")).toContain("a catch rate");
    expect(scoringIn("it caught two of them")).toContain("a caught count");
    expect(scoringIn("2 of 5")).toContain("an N-of-M rate");
    expect(scoringIn("scored above the threshold")).toEqual(expect.arrayContaining(["a score", "a threshold"]));
    expect(scoringIn("three hits and one miss")).toContain("a hit/miss tally");
    expect(scoringIn("the reviewer was handed the diff and answered in one line")).toEqual([]);
  });

  test("the reviewer's OWN arithmetic survives verbatim — the exemption is the point", () => {
    const rendered = renderTranscript(OBS);
    // Not redacted, not flagged: it is the material the verifier has to read.
    expect(rendered.text).toContain("I found 3 of 5 things worth reporting.");
    expect(rendered.scoring).toEqual([]);
  });

  test("NEGATIVE CONTROL: a run that published a rate is refused before it can ride in verbatim", () => {
    expect(rateIn("  catch rate 3 of 5 — defects the reviewers named")).toBe(true);
    expect(rateIn("reviewers reported 2 defect(s); no --planted count was given, so there is no rate")).toBe(false);
  });
});

describe("the artefact holds what a verifier who was not present needs", () => {
  const text = renderTranscript(OBS).text;

  test("the routing, by vendor name, and how it was determined", () => {
    expect(text).toContain("builder vendor: codex");
    expect(text).toContain("reviewer vendor: claude");
    expect(text).toContain("from the two SPAWNS");
    // Said out loud rather than implied: no fixture ledger backs a real vendor.
    expect(text).toContain("no fixture ledger");
  });

  test("the exact diff, and the command to re-derive it", () => {
    expect(text).toContain("+  return items[index + 1];");
    expect(text).toContain("git -C /w/verifier-repo diff aaa..refs/brigadier/run-0007/item/1");
  });

  test("the reviewer's full response, raw and rendered", () => {
    expect(text).toContain('"sessionUpdate":"agent_message_chunk"');
    expect(text).toContain("The change drops the null check. I found 3 of 5 things worth reporting.");
  });

  test("the planted defects in the verifier's own words", () => {
    expect(text).toContain("I planted it by hand on 2026-08-19.");
  });

  test("every promise in VERIFIER_NEEDS has a section behind it", () => {
    expect(VERIFIER_NEEDS.length).toBe(4);
    for (const need of VERIFIER_NEEDS) expect(need.length).toBeGreaterThan(20);
  });
});

describe("the reviewer's frames are the reviewer's", () => {
  const frames = reviewerFrames(LOG, "verifier");

  test("builder frames, outbound frames and other items are excluded", () => {
    expect(frames).toHaveLength(3);
    expect(frames.join("\n")).not.toContain("I am the BUILDER");
    expect(frames.join("\n")).not.toContain("a different item's reviewer");
    expect(frames.every((f) => f.startsWith("verifier review in "))).toBe(true);
  });

  test("the rendered text is the message chunks in order, and nothing else", () => {
    expect(reviewerText(frames)).toBe("The change drops the null check. I found 3 of 5 things worth reporting.");
    expect(reviewerText(frames)).not.toContain("tool_call");
  });

  test("NEGATIVE CONTROL: a log with no reviewer frames renders as absence, not as silence", () => {
    expect(reviewerFrames("verifier in something\n", "verifier")).toEqual([]);
    const empty = renderTranscript({ ...OBS, reviewerFrames: [], reviewerText: "" });
    expect(empty.text).toContain("(no reviewer frames in the transcript)");
    expect(empty.text).toContain("(the reviewer produced no message text)");
  });

  test("a frame that is not JSON is skipped in the rendering and kept in the raw block", () => {
    const broken = ["verifier review in {not json", `verifier review in ${chunk("real")}`];
    expect(reviewerText(broken)).toBe("real");
    expect(renderTranscript({ ...OBS, reviewerFrames: broken }).text).toContain("{not json");
  });
});

describe("it cannot be started by accident", () => {
  const base = [
    "--binary", "dist/brigadier", "--repo", ".", "--run-root", "/w/runs",
    "--defects", "package.json", "--prompt", "package.json", "--out", "/w/out",
  ];

  test("NEGATIVE CONTROL: without the spend flag it refuses", () => {
    const parsed = parseVerifierArgs(base);
    expect("error" in parsed && parsed.error).toContain(SPEND_FLAG);
  });

  test("NEGATIVE CONTROL: a missing argument refuses", () => {
    const parsed = parseVerifierArgs([...base.slice(0, 4), SPEND_FLAG]);
    expect("error" in parsed && parsed.error).toContain("missing");
  });

  test("NEGATIVE CONTROL: an input that is not on disk refuses", () => {
    const parsed = parseVerifierArgs([...base.slice(0, 6), "--defects", "/nope/x", "--prompt", "package.json", "--out", "/w/out", SPEND_FLAG]);
    expect("error" in parsed && parsed.error).toContain("do not exist on disk");
  });

  test("with the flag and real files it parses", () => {
    const parsed = parseVerifierArgs([...base, "--paths", "src/candidate.ts", SPEND_FLAG]);
    expect("error" in parsed).toBe(false);
    expect("error" in parsed ? [] : parsed.paths).toEqual(["src/candidate.ts"]);
  });
});

describe("the prompt is prose, and it puts the defects where the reviewer can see them", () => {
  test("it names the source and the target and explains why the copy is the point", () => {
    const prompt = transcribePrompt("defects/candidate.ts", "src/candidate.ts");
    expect(prompt).toContain("defects/candidate.ts");
    expect(prompt).toContain("src/candidate.ts");
    expect(prompt).toContain("base commit");
    // Prose only: nothing here is a fixture channel a real agent would ignore.
    expect(prompt).not.toContain("BAR-DIRECTIVE");
    expect(prompt).not.toContain('"do":');
  });
});
