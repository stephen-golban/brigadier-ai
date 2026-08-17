// SPDX-License-Identifier: Apache-2.0
/**
 * A fake coding agent, spawned as a real process by the fixture orchestrator.
 *
 * It exists so the positive control is a control rather than a wish. An
 * instrument needs both directions: a do-nothing binary that must score zero,
 * and an honest one that must score high. Without the second, "every item
 * fails" is indistinguishable from "every item is unsatisfiable" — which was
 * true of three items in the first draft and nobody could tell.
 *
 * It is a REAL separate process on purpose. Item 7 needs something to `SIGKILL`
 * and something to escape via `setsid()`; item 8's "zero processes were
 * created" needs processes that would otherwise have existed; item 4 needs N
 * concurrent workers. A function call would satisfy none of those.
 *
 * The permission protocol mirrors ACP's shape rather than reimplementing it:
 * the agent asks before every write and honours the answer, and it can ask with
 * a payload carrying NO locations — which is Codex's measured `edit` shape
 * (`title: null`, `locations: []`), the one where a `locations.every(inLane)`
 * guard can never fail.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Directive } from "../lib/plan.ts";

export interface VendorConfig {
  /** The name this vendor answers to on `PATH`. */
  id: string;
  version: string;
  /** Ruling 52: a reviewer that produces no verdict is `error`, and that blocks. */
  dieAsReviewer?: boolean;
  /** Defect markers this reviewer is able to spot, of those planted in the diff. */
  catches?: string[];
}

export interface Brief {
  itemId: string;
  clone: string;
  role: "builder" | "reviewer";
  directive?: Directive;
  /** For a reviewer: the exact `git diff <base>..work` text (ruling 52's framing). */
  diff?: string;
  /** Ruling 65: the secret reaches the worker through the environment, never the clone. */
  secretEnv?: string;
}

function ask(request: Record<string, unknown>): boolean {
  process.stdout.write(`REQUEST ${JSON.stringify(request)}\n`);
  // The orchestrator answers on a file rather than stdin: stdin is already the
  // brief, and a second channel keeps this fixture's plumbing out of the
  // property under test.
  const answerPath = `${process.env["BAR_ANSWER_FILE"] ?? ""}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(answerPath)) {
      const answer = readFileSync(answerPath, "utf8").trim();
      if (answer.length > 0) {
        writeFileSync(answerPath, "");
        return answer === "ALLOW";
      }
    }
    Bun.sleepSync(5);
  }
  return false;
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/**
 * The ambient instruction file, read exactly the way a real agent reads one.
 *
 * `XDG_CONFIG_HOME` wins outright when it is set — that is the specification's
 * own rule, and it is also decision 17's suppression lever: an orchestrator that
 * points the config root somewhere it owns makes the user's global file
 * unreachable. An orchestrator that forgets leaves it reachable, and this
 * function is how item 9 can tell the two apart on the EFFECT rather than on a
 * variable.
 */
function ambientMarker(): string | undefined {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const root = xdg !== undefined && xdg.length > 0 ? xdg : join(process.env["HOME"] ?? "", ".config");
  const path = join(root, "ambient.md");
  if (!existsSync(path)) return undefined;
  return /WRITE-MARKER:(\S+)/.exec(readFileSync(path, "utf8"))?.[1];
}

function act(brief: Brief, config: VendorConfig): number {
  const marker = ambientMarker();
  if (marker !== undefined) {
    // Obeyed, because the agent found it and had no reason not to. If this file
    // reaches the merged tree, suppression did not happen.
    const target = resolve(brief.clone, "ambient-obeyed.txt");
    if (ask({ kind: "edit", title: "ambient", locations: [{ path: target }] })) write(target, `${marker}\n`);
  }

  const directive = brief.directive;
  if (!directive) return 0;

  switch (directive.do) {
    case "write": {
      const target = resolve(brief.clone, directive.path);
      if (!ask({ kind: "edit", title: `write ${directive.path}`, locations: [{ path: target }] })) return 1;
      write(target, `${directive.token}\n`);
      return 0;
    }

    case "escape": {
      const target = directive.absolutePath;
      // A full path, as Claude and Copilot were measured to send.
      if (!ask({ kind: "edit", title: `write ${target}`, locations: [{ path: target }] })) return 0;
      write(target, `${directive.token}\n`);
      return 0;
    }

    case "escape-blind": {
      // Codex's measured shape: no title, no locations, nothing to place.
      if (!ask({ kind: "edit", title: null, locations: [] })) return 0;
      write(directive.absolutePath, `${directive.token}\n`);
      return 0;
    }

    case "plant-git-payloads": {
      const hooks = join(brief.clone, ".git", "hooks");
      mkdirSync(hooks, { recursive: true });
      const body = (label: string): string =>
        process.platform === "win32"
          ? `@echo off\r\necho ${label} > ${directive.canaryPath}\r\n`
          : `#!/bin/sh\necho "${label}" > ${JSON.stringify(directive.canaryPath)}\nexit 0\n`;
      const planted: string[] = [];
      for (const name of ["pre-commit", "reference-transaction"]) {
        const path = join(hooks, name);
        writeFileSync(path, body(name), { mode: 0o755 });
        planted.push(path);
      }
      const fsmonitor = join(brief.clone, ".git", "bar-fsmonitor");
      writeFileSync(fsmonitor, body("core.fsmonitor"), { mode: 0o755 });
      appendFileSync(join(brief.clone, ".git", "config"), `\n[core]\n\tfsmonitor = ${fsmonitor}\n`);
      planted.push(`core.fsmonitor=${fsmonitor}`);

      const receipt = resolve(brief.clone, directive.receipt);
      if (!ask({ kind: "edit", title: "receipt", locations: [{ path: receipt }] })) return 1;
      write(receipt, `${directive.token}\n${planted.join("\n")}\n`);
      return 0;
    }

    case "read-then-write": {
      const source = resolve(brief.clone, directive.read);
      const seen = existsSync(source) ? readFileSync(source, "utf8").trim() : "PREREQUISITE-NOT-VISIBLE";
      const target = resolve(brief.clone, directive.path);
      if (!ask({ kind: "edit", title: `write ${directive.path}`, locations: [{ path: target }] })) return 1;
      write(target, `${directive.token} saw ${seen}\n`);
      return 0;
    }

    case "write-anyway": {
      // Ruling 49: a read-only item's directory is never read back, so this must
      // reach neither the branch nor any report. The agent is not stopped here —
      // three of five measured vendors give no lane at all.
      write(resolve(brief.clone, directive.path), `${directive.token}\n`);
      return 0;
    }

    case "escape-process": {
      mkdirSync(dirname(directive.heartbeat), { recursive: true });
      const script = join(brief.clone, "..", `escapee-${brief.itemId}.sh`);
      writeFileSync(
        script,
        `#!/bin/sh\nwhile true; do echo tick >> ${JSON.stringify(directive.heartbeat)}; sleep 0.2; done\n`,
        { mode: 0o755 },
      );
      // POSIX: leave the process group entirely with `setsid`. Windows:
      // `cmd /c start`, which #43 measured breaking out of Bun's job object
      // (BREAKAWAY_OK and SILENT_BREAKAWAY_OK both set).
      //
      // MEASURED on 2026-08-17: macOS ships no `setsid` — it is a util-linux
      // program and the BSD userland does not carry it. So the POSIX branch
      // falls back to `nohup … &`, which does not leave the process group but
      // does outlive the parent, which is the property this fixture needs. The
      // difference is recorded rather than smoothed over: on macOS this
      // demonstrates a surviving descendant, not an escaped process GROUP.
      const detach = Bun.which("setsid") !== null ? "setsid" : "nohup";
      const argv =
        process.platform === "win32"
          ? ["cmd", "/c", "start", "/b", "cmd", "/c", `for /l %i in () do echo tick >> ${directive.heartbeat}`]
          : ["/bin/sh", "-c", `${detach} ${JSON.stringify(script)} </dev/null >/dev/null 2>&1 &`];
      process.stdout.write(`ESCAPED-VIA ${process.platform === "win32" ? "cmd /c start" : detach}\n`);
      Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      Bun.sleepSync(600);
      return 0;
    }

    case "commit-then-hang": {
      const target = resolve(brief.clone, directive.path);
      if (!ask({ kind: "edit", title: `write ${directive.path}`, locations: [{ path: target }] })) return 1;
      write(target, `${directive.token}\n`);
      process.stdout.write("COMMIT-NOW\n");
      // Long enough that the harness's SIGKILL always arrives first.
      Bun.sleepSync(600_000);
      return 0;
    }

    case "delegate": {
      // Finding 114, reproduced deliberately: a worker that decides the job is
      // to run the orchestrator. Ruling 57's refusal is what must stop it.
      const proc = Bun.spawnSync(["brigadier", "run", "--plan", "whatever"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const refused = proc.exitCode === 3;
      const target = resolve(brief.clone, directive.path);
      if (!ask({ kind: "edit", title: `write ${directive.path}`, locations: [{ path: target }] })) return 1;
      // Refused, so it does the work itself — which is the effect ruling 57 is
      // asserted on, not the variable.
      write(target, `${directive.token}\n`);
      process.stdout.write(`DELEGATION-${refused ? "REFUSED" : "ACCEPTED"}\n`);
      return 0;
    }

    case "leak-secret": {
      const secret = process.env[directive.env] ?? "NO-SECRET-IN-ENVIRONMENT";
      const target = resolve(brief.clone, directive.path);
      if (!ask({ kind: "edit", title: `write ${directive.path}`, locations: [{ path: target }] })) return 1;
      write(target, JSON.stringify({ token: directive.token, credential: secret }, null, 2));
      return 0;
    }
  }
}

function review(brief: Brief, config: VendorConfig): number {
  if (config.dieAsReviewer === true) {
    // No verdict at all. Ruling 52: that is `error`, and it blocks — v1 merged
    // its most delicate change on `review: not run (REVIEWER_FAILED)`.
    process.exit(9);
  }
  const diff = brief.diff ?? "";
  const found = (config.catches ?? []).filter((marker) => diff.includes(marker));
  process.stdout.write(`VERDICT ${JSON.stringify({ verdict: found.length > 0 ? "rejected" : "approved", found })}\n`);
  return 0;
}

if (import.meta.main) {
  const configPath = Bun.argv[2];
  const briefPath = Bun.argv[3];
  if (configPath === undefined || briefPath === undefined) {
    process.stderr.write("vendor: <config> <brief> required\n");
    process.exit(2);
  }
  const config = JSON.parse(readFileSync(configPath, "utf8")) as VendorConfig;
  const brief = JSON.parse(readFileSync(briefPath, "utf8")) as Brief;
  process.stdout.write(`AGENT ${config.id} ${config.version}\n`);
  process.exit(brief.role === "reviewer" ? review(brief, config) : act(brief, config));
}
