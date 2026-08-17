import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { Lane, extractPaths } from "../src/lane/lane.ts";

let root: string;
let outside: string;

beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-lane-")));
  root = join(base, "clone");
  outside = join(base, "elsewhere");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  // The v1 escape: a symlink out of the lane that `resolve()` would collapse
  // lexically and never notice.
  symlinkSync(outside, join(root, "escape-hatch"));
});

afterAll(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

const editRequest = (...paths: string[]) => ({
  toolCall: { kind: "edit", title: "Edit", locations: paths.map((path) => ({ path })) },
});

describe("Lane", () => {
  test("allows a write inside the lane", () => {
    const verdict = new Lane(root).decide(editRequest(join(root, "src", "b.ts")));
    expect(verdict.decision).toBe("allow");
    expect(verdict.reason).toBe("in-lane");
  });

  // The control for the test above: the same guard must be able to say no.
  test("denies a write outside the lane", () => {
    const verdict = new Lane(root).decide(editRequest(join(outside, "loot.txt")));
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toBe("out-of-lane");
  });

  test("denies a path that escapes through a symlink — v1's measured escape", () => {
    // Lexically this is inside the lane. Physically it is not.
    const viaSymlink = join(root, "escape-hatch", "loot.txt");
    const verdict = new Lane(root).decide(editRequest(viaSymlink));
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toBe("out-of-lane");
  });

  test("denies a path that escapes with ..", () => {
    const verdict = new Lane(root).decide(editRequest(join(root, "..", "elsewhere", "loot.txt")));
    expect(verdict.decision).toBe("deny");
  });

  test("denies .git even though it is inside the lane — decision 34", () => {
    const verdict = new Lane(root).decide(editRequest(join(root, ".git", "hooks", "pre-commit")));
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toBe("git-internal");
  });

  /**
   * THE load-bearing test. Codex sends `locations: []` with no title and no
   * rawInput, so `locations.every(inLane)` is vacuously true and the natural
   * guard can never fail. If this test ever goes green on "allow", the lane has
   * silently stopped being a lane on the vendor that tells us least.
   */
  test("denies an unplaceable request — the Codex shape", () => {
    const verdict = new Lane(root).decide({
      toolCall: { kind: "edit", title: null, locations: [], rawInput: null },
    });
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toBe("unplaceable");
  });

  test("denies a shell command whose paths we refuse to parse — the Claude execute shape", () => {
    const verdict = new Lane(root).decide({
      toolCall: {
        kind: "execute",
        title: null,
        locations: [],
        rawInput: { command: `printf x > ${join(outside, "loot.txt")}` },
      },
    });
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toBe("unplaceable");
  });

  test("denies when only SOME paths are in lane", () => {
    const verdict = new Lane(root).decide(
      editRequest(join(root, "src", "ok.ts"), join(outside, "loot.txt")),
    );
    expect(verdict.decision).toBe("deny");
  });

  test("policies bypass containment, and are labelled so a report cannot call them a pass", () => {
    const allowed = new Lane(root, "allow").decide(editRequest(join(outside, "loot.txt")));
    expect(allowed.decision).toBe("allow");
    expect(allowed.reason).toBe("policy-allow");

    const denied = new Lane(root, "deny").decide(editRequest(join(root, "src", "a.ts")));
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toBe("policy-deny");
  });
});

describe("extractPaths", () => {
  test("reads locations", () => {
    expect(extractPaths(editRequest("/a", "/b"))).toEqual(["/a", "/b"]);
  });

  test("reads Copilot's rawInput.fileName and opencode's rawInput.filepath", () => {
    expect(extractPaths({ toolCall: { rawInput: { fileName: "/a" } } })).toEqual(["/a"]);
    expect(extractPaths({ toolCall: { rawInput: { filepath: "/b" } } })).toEqual(["/b"]);
  });

  test("does NOT parse paths out of a shell string", () => {
    // Deliberate: a shell parser with an attacker on the other side is a way to
    // allow a write we could not actually see.
    expect(extractPaths({ toolCall: { rawInput: { command: "rm -rf /tmp/x" } } })).toEqual([]);
  });

  test("de-duplicates", () => {
    expect(extractPaths({ toolCall: { locations: [{ path: "/a" }], rawInput: { path: "/a" } } })).toEqual(["/a"]);
  });
});
