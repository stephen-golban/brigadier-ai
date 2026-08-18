// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 38's marker, and the two ways a matcher gets this wrong.
 *
 * Too loose and the sweep kills a process the operator started — `--brigadier-runner`,
 * a path that happens to contain the flag, another run's worker. Too tight and
 * the sweep finds nothing, which looks exactly like a clean machine. Every test
 * below is one of those two directions, and each is a demonstrated negative
 * rather than a restatement of the happy path.
 */

import { describe, expect, test } from "bun:test";
import { RUN_MARKER_FLAG, WORKER_MARKER } from "../src/agent/marker.ts";
import { markerMatches, parseRunMarker, runMarkerArg } from "../src/run/marker.ts";

describe("the marker goes in the command line", () => {
  test("it is built from the flag brigadier already declares", () => {
    expect(runMarkerArg("a1b2c3", 7)).toBe(`${RUN_MARKER_FLAG}=a1b2c3/7`);
  });

  test("a run id that could escape the namespace is refused at construction", () => {
    // The same shape refs.ts enforces. A marker carrying a space would break the
    // parse; one carrying a slash would make the item unreadable.
    expect(() => runMarkerArg("a b", 1)).toThrow(/unusable run id/);
    expect(() => runMarkerArg("../evil", 1)).toThrow(/unusable run id/);
    expect(() => runMarkerArg("ok", 0)).toThrow(/unusable item number/);
  });

  test("it round-trips out of a full command line", () => {
    const line = `/usr/local/bin/bun run worker.ts --plan p.json ${runMarkerArg("run-9", 3)} --repo /x`;
    expect(parseRunMarker(line)).toEqual({ runId: "run-9", item: 3 });
  });

  test("the space-separated form is read, because argv joining is not ours to control", () => {
    expect(parseRunMarker(`codex exec ${RUN_MARKER_FLAG} run-9/3`)).toEqual({ runId: "run-9", item: 3 });
  });
});

describe("negative controls: what must NOT match", () => {
  test("a longer flag with the same prefix does not match", () => {
    // `--brigadier-runner=...` shares every character of the flag and is not it.
    expect(parseRunMarker(`node x.js ${RUN_MARKER_FLAG}ner=run-9/3`)).toBeNull();
  });

  test("the flag embedded in a longer word does not match", () => {
    expect(parseRunMarker(`node x.js --not${RUN_MARKER_FLAG}=run-9/3`)).toBeNull();
  });

  test("a command line with no marker at all does not match", () => {
    // This is the case that matters most: the operator's own editor, shell and
    // language server are all in the same `ps` output.
    expect(parseRunMarker("/usr/bin/node /Users/x/.vscode/server/out/server-main.js")).toBeNull();
    expect(parseRunMarker("bun test")).toBeNull();
  });

  test("a malformed value does not match", () => {
    for (const value of ["", "run-9", "run-9/", "/3", "run-9/0", "run-9/-1", "run-9/x"]) {
      expect(parseRunMarker(`bun x.ts ${RUN_MARKER_FLAG}=${value}`)).toBeNull();
    }
  });

  test("the ENVIRONMENT marker is not this marker (ruling 57)", () => {
    // Two markers for two purposes. A sweep scanning `ps` cannot see
    // BRIGADIER_WORKER, and a binary checking process.env cannot see this one.
    // A command line that only carries the env var's NAME must not match.
    expect(parseRunMarker(`env ${WORKER_MARKER}=run-9/3 bun worker.ts`)).toBeNull();
    expect(WORKER_MARKER).not.toBe(RUN_MARKER_FLAG);
  });
});

describe("scope is exact in both fields", () => {
  const line = `bun worker.ts ${runMarkerArg("run-9", 3)}`;

  test("the run and item both have to agree", () => {
    expect(markerMatches(line, { runId: "run-9", item: 3 })).toBe(true);
    expect(markerMatches(line, { runId: "run-9" })).toBe(true);
  });

  test("another item of the same run is not this item", () => {
    // `assertReclaimed` refuses evidence that names a different item, so a
    // matcher that was loose here would produce evidence isolation rejects —
    // or worse, kill a sibling worker that is doing its job.
    expect(markerMatches(line, { runId: "run-9", item: 4 })).toBe(false);
  });

  test("another run is never ours to reclaim", () => {
    expect(markerMatches(line, { runId: "run-8" })).toBe(false);
    // Prefix collision: a run id that begins with another run id.
    expect(markerMatches(`bun w.ts ${runMarkerArg("run-90", 3)}`, { runId: "run-9" })).toBe(false);
  });
});
