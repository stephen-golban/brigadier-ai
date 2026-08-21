// SPDX-License-Identifier: Apache-2.0
/**
 * Rulings 76 and 77 — `brigadier setup` and the shim it installs.
 *
 * The assertions that matter here are the ones about NOT doing things: setup
 * does not overwrite an existing config, does not edit a shell profile without
 * the flag, and does not append a second block when run twice. Ruling 76's cap
 * is *writes files and prints; never asks, never runs work*, and a cap is only
 * real where something proves it held.
 */

import { describe, expect, test } from "bun:test";
import {
  BLOCK_END,
  BLOCK_START,
  onPath,
  pathLine,
  profileBlock,
  profileFor,
  shellFrom,
  shimDirectory,
  shimPath,
  shimText,
  withBlock,
  withoutBlock,
} from "../src/setup/shim.ts";
import { DEFAULT_CONFIG } from "../src/config/config.ts";
import { configDocument, describeSetup, pathAdvice, planSetup, proposeRoles } from "../src/setup/setup.ts";
import type { AgentId } from "../src/agent/profiles.ts";

const HOME = "/home/example";
const ROOT = "/home/example/.brigadier";

function agents(usable: readonly string[], absent: readonly string[] = []) {
  return [
    ...usable.map((id) => ({ id: id as AgentId, usable: true })),
    ...absent.map((id) => ({ id: id as AgentId, usable: false })),
  ];
}

describe("the shim, and what it execs", () => {
  test("one stable PATH entry, inside a directory brigadier owns", () => {
    expect(shimDirectory(ROOT)).toBe("/home/example/.brigadier/bin");
    expect(shimPath(ROOT, "darwin")).toBe("/home/example/.brigadier/bin/brigadier");
    expect(shimPath(ROOT, "win32")).toContain("brigadier.cmd");
  });

  test("the target is QUOTED, because a home directory with a space in it is ordinary", () => {
    const posix = shimText("/Users/Ann Lee/bin/brigadier", "darwin");
    expect(posix).toContain(`exec "/Users/Ann Lee/bin/brigadier" "$@"`);
    const windows = shimText(String.raw`C:\Users\Ann Lee\brigadier.exe`, "win32");
    expect(windows).toContain(`"C:\\Users\\Ann Lee\\brigadier.exe" %*`);
  });

  test("POSIX uses `exec`, so no shell survives into ruling 38's process tree", () => {
    expect(shimText("/bin/b", "darwin").split("\n").some((l) => l.startsWith("exec "))).toBe(true);
  });

  test("Windows gets CRLF and no shebang", () => {
    const windows = shimText("C:/b.exe", "win32");
    expect(windows).toContain("\r\n");
    expect(windows).not.toContain("#!");
  });
});

describe("is it on PATH — entry by entry, never by substring", () => {
  test("a real entry is found and a trailing separator does not hide it", () => {
    expect(onPath("/a/bin", "/x:/a/bin:/y")).toBe(true);
    expect(onPath("/a/bin", "/x:/a/bin/:/y")).toBe(true);
  });

  test("a SUBSTRING match is not a PATH entry", () => {
    // The negative control for the check above, and the bug it exists to
    // prevent: `/a/bin` is a substring of `/a/binaries`, and a `PATH.includes()`
    // implementation would report a directory as reachable when it is not —
    // then setup prints "nothing to do" and `brigadier` does not resolve.
    expect(onPath("/a/bin", "/a/binaries:/y")).toBe(false);
  });

  test("an empty or absent PATH is not on PATH", () => {
    expect(onPath("/a/bin", "")).toBe(false);
    expect(onPath("/a/bin", undefined)).toBe(false);
  });
});

describe("which shell, and the line it needs", () => {
  test("$SHELL is read, and an unknown shell stays unknown rather than defaulting", () => {
    expect(shellFrom({ SHELL: "/bin/zsh" })).toBe("zsh");
    expect(shellFrom({ SHELL: "/usr/local/bin/fish" })).toBe("fish");
    expect(shellFrom({ SHELL: "/bin/bash" })).toBe("bash");
    expect(shellFrom({ SHELL: "/usr/bin/nu" })).toBe("unknown");
    expect(shellFrom({})).toBe("unknown");
  });

  test("fish gets fish syntax, because `export PATH=` is a SYNTAX ERROR there", () => {
    // Printing one POSIX line for every shell would be wrong for one of the
    // three most common ones, and wrong in the way that breaks the next login
    // rather than failing at paste time.
    expect(pathLine("/a/bin", "fish")).toBe("fish_add_path /a/bin");
    expect(pathLine("/a/bin", "zsh")).toBe(`export PATH="/a/bin:$PATH"`);
  });

  test("an unknown shell gets NO profile guessed for it", () => {
    expect(profileFor("unknown", HOME)).toBeUndefined();
    expect(profileFor("zsh", HOME)).toBe("/home/example/.zshrc");
    expect(profileFor("fish", HOME)).toBe("/home/example/.config/fish/config.fish");
  });
});

describe("the delimited block, which exists so uninstall can be exact", () => {
  test("a block is added once and only once", () => {
    const first = withBlock("# my profile\n", "/a/bin", "zsh");
    expect(first).toBeDefined();
    expect(first).toContain(BLOCK_START);
    expect(first).toContain(BLOCK_END);
    // Running `setup --modify-path` twice is an ordinary thing to do. Two
    // blocks would double the PATH entry and make removal ambiguous.
    expect(withBlock(first as string, "/a/bin", "zsh")).toBeUndefined();
  });

  test("a profile with no trailing newline does not get its last line eaten", () => {
    const out = withBlock("export FOO=1", "/a/bin", "zsh") as string;
    expect(out.startsWith("export FOO=1\n")).toBe(true);
  });

  test("removal restores the file, byte for byte", () => {
    const original = "# my profile\nexport FOO=1\n";
    const added = withBlock(original, "/a/bin", "zsh") as string;
    expect(withoutBlock(added)).toBe(original);
  });

  test("a file with no block is left alone rather than rewritten", () => {
    expect(withoutBlock("export FOO=1\n")).toBeUndefined();
  });

  test("an UNPAIRED marker REFUSES instead of deleting to end of file", () => {
    // Somebody edited inside the block. Deleting from the start marker onward
    // on that assumption is the "delete a user's file by walking a computed
    // path" failure ruling 51 keeps structurally impossible everywhere else.
    expect(withoutBlock(`# my profile\n${BLOCK_START}\nexport PATH=x\n`)).toBe("unpaired");
  });

  test("the block is pnpm's shape, which is already on the owner's machine", () => {
    expect(profileBlock("/a/bin", "zsh")).toBe(`${BLOCK_START}\nexport PATH="/a/bin:$PATH"\n${BLOCK_END}\n`);
  });
});

describe("ruling 71's role proposal: proposed, never asked", () => {
  test("usable agents are proposed for both roles", () => {
    const roles = proposeRoles(agents(["claude", "codex"]));
    expect(roles.builder?.length).toBeGreaterThan(0);
    expect(roles.reviewer?.length).toBeGreaterThan(0);
  });

  test("an UNUSABLE agent is never proposed", () => {
    const roles = proposeRoles(agents(["claude"], ["codex", "qwen"]));
    expect(roles.builder).not.toContain("codex");
    expect(roles.reviewer).not.toContain("qwen");
  });

  test("nothing detected proposes nothing, rather than proposing everything", () => {
    expect(proposeRoles(agents([], ["claude", "codex"]))).toEqual({});
    expect(proposeRoles([])).toEqual({});
  });

  test("each agent appears once per role, not once per (agent, model)", () => {
    const roles = proposeRoles(agents(["claude", "codex"]));
    const builder = roles.builder ?? [];
    expect(new Set(builder).size).toBe(builder.length);
  });

  test("ruling 68's fail-open half: an unranked usable agent is still proposed, LAST", () => {
    // v1's finding 87 is a model scored 85 silently excluded from every hard
    // item. Dropping an unranked agent here would rebuild that in the one place
    // a first-time user would never look.
    const roles = proposeRoles(agents(["claude", "codex", "copilot", "qwen", "opencode", "gemini"]));
    const builder = roles.builder ?? [];
    for (const id of ["claude", "codex", "copilot", "qwen", "opencode", "gemini"]) {
      expect(builder).toContain(id);
    }
  });
});

describe("ruling 76's cap: writes files and prints", () => {
  const base = {
    configPath: "/home/example/.config/brigadier/config.json",
    root: ROOT,
    binary: "/opt/brigadier",
    binaryIsArtifact: true,
    home: HOME,
    detected: agents(["claude", "codex"]),
    platform: "darwin" as NodeJS.Platform,
  };

  test("an EXISTING config is left exactly as it is", () => {
    const plan = planSetup({ ...base, configExists: true, env: {} });
    expect(plan.writeConfig).toBe(false);
    // Setup must be safe to run twice. A destructive second run is the one
    // property that would stop anyone running it at all.
    expect(describeSetup(plan, base.detected, undefined, false).join("\n")).toContain("left exactly as it is");
  });

  test("a fresh machine gets a config carrying the proposal", () => {
    const plan = planSetup({ ...base, configExists: false, env: {} });
    expect(plan.writeConfig).toBe(true);
    expect(plan.config.roles.builder?.length).toBeGreaterThan(0);
    expect(plan.config.possession.enabled).toBe(true);
    expect(plan.config.ambientSuppression).toBe(true);
  });

  test("the document written is valid JSON and round-trips through the parser", () => {
    const plan = planSetup({ ...base, configExists: false, env: {} });
    const text = configDocument(plan.config);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text).explorationFloor).toBe(DEFAULT_CONFIG.explorationFloor);
  });

  test("PATH advice says nothing to do when the directory is already there", () => {
    const plan = planSetup({ ...base, configExists: true, env: { PATH: `${shimDirectory(ROOT)}:/usr/bin` } });
    expect(plan.alreadyOnPath).toBe(true);
    expect(pathAdvice(plan, undefined).join("\n")).toContain("already on your PATH");
  });

  test("without --modify-path it PRINTS the line and names the guess as a guess", () => {
    const plan = planSetup({ ...base, configExists: true, env: { PATH: "/usr/bin", SHELL: "/bin/zsh" } });
    const advice = pathAdvice(plan, undefined).join("\n");
    expect(advice).toContain(`export PATH="${shimDirectory(ROOT)}:$PATH"`);
    expect(advice).toContain("guessed from $SHELL");
    expect(advice).toContain("--modify-path");
    // The refusal to write is the ruling. If this ever starts saying it wrote
    // something, ruling 77's default has been reversed without a ruling.
    expect(advice).toContain("does not write that for you by default");
  });

  test("with --modify-path it names the file and the markers", () => {
    const plan = planSetup({ ...base, configExists: true, env: { PATH: "/usr/bin", SHELL: "/bin/zsh" } });
    const advice = pathAdvice(plan, "/home/example/.zshrc").join("\n");
    expect(advice).toContain("/home/example/.zshrc");
    expect(advice).toContain(BLOCK_START);
  });
});

describe("what setup prints, which is where the unlearnable things live", () => {
  const plan = planSetup({
    configPath: "/c.json",
    configExists: false,
    root: ROOT,
    binary: "/opt/brigadier",
    binaryIsArtifact: true,
    home: HOME,
    env: {},
    platform: "darwin",
    detected: agents(["claude"]),
  });

  test("ruling 71's four unlearnable things appear here too, not only on first run", () => {
    const out = describeSetup(plan, agents(["claude"]), undefined, false).join("\n");
    expect(out).toContain("SUPPRESSED");
    expect(out).toContain("does NOT cover external services");
  });

  test("ruling 32: a single-vendor machine is TOLD that review runs same-vendor", () => {
    const out = describeSetup(plan, agents(["claude"]), undefined, false).join("\n");
    expect(out).toContain("SAME-VENDOR");
  });

  test("two vendors are told cross-vendor review is available", () => {
    const out = describeSetup(plan, agents(["claude", "codex"]), undefined, false).join("\n");
    expect(out).toContain("Cross-vendor review is available");
  });

  test("nothing usable says so, and does not pretend a run would work", () => {
    const out = describeSetup(plan, agents([], ["claude"]), undefined, false).join("\n");
    expect(out).toContain("No vendor is drivable");
  });

  test("ruling 73's limit is restated: this is the machine at the instant it ran", () => {
    const out = describeSetup(plan, agents(["claude"]), undefined, false).join("\n");
    expect(out).toContain("right now");
  });

  test("--dry-run scopes its claim to brigadier, in its first line", () => {
    // Not "nothing was written": the sweep spawns real vendors and they write
    // their own files. See the dry-run caveat test below.
    expect(describeSetup(plan, agents(["claude"]), undefined, true)[0]).toContain("brigadier wrote nothing");
  });
});

describe("the two things driving it against a real home found", () => {
  const base = {
    configPath: "/c.json",
    configExists: true,
    root: ROOT,
    home: HOME,
    env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
    platform: "darwin" as NodeJS.Platform,
    detected: agents(["claude"]),
  };

  test("an INTERPRETER is not a brigadier artifact, and no shim is written from one", () => {
    // MEASURED 2026-08-21: `bun run src/cli.ts setup` has
    // `process.execPath === /Users/.../.bun/bin/bun`. A shim built from that
    // execs bun with the operator's arguments — created successfully, reported
    // successfully, broken the first time anyone types `brigadier`.
    const plan = planSetup({ ...base, binary: "/Users/x/.bun/bin/bun", binaryIsArtifact: false });
    const out = describeSetup(plan, base.detected, undefined, false).join("\n");
    expect(out).toContain("shim       NOT written");
    expect(out).toContain("interpreter and not a brigadier");
    // And it must NOT print the paste-this-line advice for a shim that is not there.
    expect(out).not.toContain("Add this line to");
  });

  test("a real artifact still gets the shim and the PATH line", () => {
    const plan = planSetup({ ...base, binary: "/opt/brigadier", binaryIsArtifact: true });
    const out = describeSetup(plan, base.detected, undefined, false).join("\n");
    expect(out).toContain("shim       ");
    expect(out).toContain("Add this line to");
  });

  test("--dry-run says BRIGADIER wrote nothing, and names what the probes wrote", () => {
    // Ruling 52: v1's output was "truthful in detail and false in summary, and
    // people read summaries". MEASURED against a throwaway home on 2026-08-21, a
    // dry run left gemini's installation_id, opencode's database and npm's logs
    // behind — all written by probed vendors, none by brigadier. "Nothing was
    // written" would be true of brigadier and false of the home directory.
    const plan = planSetup({ ...base, binary: "/opt/brigadier", binaryIsArtifact: true });
    const out = describeSetup(plan, base.detected, undefined, true).join("\n");
    expect(out).toContain("brigadier wrote nothing");
    expect(out).toContain("Detection SPAWNED each vendor");
    expect(out).toContain("--dry-run does not bind them");
  });

  test("a real run does NOT carry the dry-run caveat", () => {
    const plan = planSetup({ ...base, binary: "/opt/brigadier", binaryIsArtifact: true });
    expect(describeSetup(plan, base.detected, undefined, false).join("\n")).not.toContain("does not bind them");
  });
});
