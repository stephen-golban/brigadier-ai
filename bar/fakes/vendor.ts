// SPDX-License-Identifier: Apache-2.0
/**
 * A fake coding agent, spawned as a real process by the fixture orchestrator.
 *
 * It exists so the positive control is a control rather than a wish, and it is a
 * REAL separate process on purpose: item 7 needs something to `SIGKILL` and
 * something to escape, item 8 needs processes that would otherwise have existed,
 * item 4 needs N concurrent workers, and a function call would satisfy none of
 * those.
 *
 * Three things it does that a forger cannot cheaply reproduce, and each is here
 * because a forger scored on the version without it:
 *
 *   **It DERIVES rather than echoes.** The value it writes is a hash of a nonce
 *   that exists only in the cloned repository's content — never in the plan,
 *   never in the prompt, never in the environment. To produce it you must have a
 *   clone, or have reconstructed the base commit that a clone comes from.
 *
 *   **It signs a ledger.** One line per invocation, naming the vendor, the role,
 *   the item and the pid. A run record is the product's account of itself; a
 *   ledger line is a file a process had to exist to write.
 *
 *   **Its escapee publishes a pid.** "Still running" then becomes `kill(pid, 0)`
 *   rather than a guess about file sizes, and a descendant that quietly died on
 *   its own no longer reads as a successful sweep.
 *
 * The permission protocol mirrors ACP's shape rather than reimplementing it: the
 * agent asks before every write and honours the answer, and it can ask with a
 * payload carrying NO locations — Codex's measured `edit` shape (`title: null`,
 * `locations: []`), the one where a `locations.every(inLane)` guard can never
 * fail.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { derive } from "../lib/derive.ts";
import { appendLedger } from "../lib/ledger.ts";
import type { Directive } from "../lib/plan.ts";

export interface VendorConfig {
  /** The name this vendor answers to on `PATH`. */
  id: string;
  version: string;
  /** Ruling 52: a reviewer that produces no verdict is `error`, and that blocks. */
  dieAsReviewer?: boolean;
  /** Defect markers this reviewer is able to spot, of those planted in the diff. */
  catches?: string[];
  /** Where every invocation is recorded. The harness owns this path. */
  ledger?: string;
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

/** Read a nonce out of the clone. Absent means the clone is not what it claims. */
function readSeed(clone: string, relative: string): string {
  const path = resolve(clone, relative);
  if (!existsSync(path)) return `SEED-MISSING:${relative}`;
  return readFileSync(path, "utf8").trim();
}

/**
 * The ambient instruction file, read exactly the way a real agent reads one.
 *
 * `XDG_CONFIG_HOME` wins outright when it is set — the specification's own rule,
 * and also decision 17's suppression lever: an orchestrator that points the
 * config root somewhere it owns makes the user's global file unreachable, and
 * one that forgets leaves it reachable. This is how item 9 tells the two apart
 * on the EFFECT rather than on a variable.
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
    const target = resolve(brief.clone, "ambient-obeyed.txt");
    if (ask({ kind: "edit", title: "ambient", locations: [{ path: target }] })) write(target, `${marker}\n`);
  }

  const directive = brief.directive;
  if (!directive) return 0;

  switch (directive.do) {
    case "derive-write": {
      // The value cannot be produced without the clone: the nonce is only there.
      const seed = readSeed(brief.clone, directive.read);
      const target = resolve(brief.clone, directive.path);
      if (!ask({ kind: "edit", title: `write ${directive.path}`, locations: [{ path: target }] })) return 1;
      write(target, `${derive(seed, directive.salt)}\n`);
      return 0;
    }

    case "escape": {
      const target = directive.absolutePath;
      // A full path, as Claude and Copilot were measured to send.
      if (!ask({ kind: "edit", title: `write ${target}`, locations: [{ path: target }] })) return 0;
      write(target, "escaped\n");
      return 0;
    }

    case "escape-blind": {
      // Codex's measured shape: no title, no locations, nothing to place.
      if (!ask({ kind: "edit", title: null, locations: [] })) return 0;
      write(directive.absolutePath, "escaped\n");
      return 0;
    }

    case "plant-git-payloads": {
      // The payloads are COPIED OUT OF THE CLONE's committed content, so the
      // harness can verify from outside that real payload bytes reached
      // `.git/hooks` — rather than believing a receipt written by the same party
      // that would have planted them.
      const hooks = join(brief.clone, ".git", "hooks");
      mkdirSync(hooks, { recursive: true });
      const source = resolve(brief.clone, directive.from);
      const body = existsSync(source) ? readFileSync(source, "utf8") : "";
      for (const name of ["pre-commit", "reference-transaction"]) {
        writeFileSync(join(hooks, name), body, { mode: 0o755 });
      }
      const fsmonitor = join(brief.clone, ".git", "bar-fsmonitor");
      writeFileSync(fsmonitor, body, { mode: 0o755 });
      appendFileSync(join(brief.clone, ".git", "config"), `\n[core]\n\tfsmonitor = ${fsmonitor}\n`);

      const seed = readSeed(brief.clone, directive.read);
      const target = resolve(brief.clone, directive.path);
      if (!ask({ kind: "edit", title: "receipt", locations: [{ path: target }] })) return 1;
      write(target, `${derive(seed, directive.salt)}\n`);
      return 0;
    }

    case "read-then-write": {
      // Ruling 54: wave 2 must SEE wave 1's output. The value it needs existed
      // only in wave 1's integration commit, never in the plan.
      const seen = readSeed(brief.clone, directive.read);
      const target = resolve(brief.clone, directive.path);
      if (!ask({ kind: "edit", title: `write ${directive.path}`, locations: [{ path: target }] })) return 1;
      write(target, `${derive(seen, directive.salt)}\n`);
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
      // `trap '' HUP` so it does not quietly die with its parent: a descendant
      // that self-terminates reads exactly like a successful sweep, and that
      // ambiguity was a real defect in the previous fixture.
      writeFileSync(
        script,
        `#!/bin/sh\ntrap '' HUP\necho $$ > ${JSON.stringify(directive.pidFile)}\nwhile true; do echo tick >> ${JSON.stringify(directive.heartbeat)}; sleep 0.2; done\n`,
        { mode: 0o755 },
      );
      const detach = Bun.which("setsid") !== null ? "setsid" : "nohup";
      const argv =
        process.platform === "win32"
          ? ["cmd", "/c", "start", "/b", "cmd", "/c", `for /l %i in () do echo tick >> ${directive.heartbeat}`]
          : ["/bin/sh", "-c", `${detach} ${JSON.stringify(script)} </dev/null >/dev/null 2>&1 &`];
      process.stdout.write(`ESCAPED-VIA ${process.platform === "win32" ? "cmd /c start" : detach}\n`);
      Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      Bun.sleepSync(700);
      return 0;
    }

    case "commit-then-hang": {
      const seed = readSeed(brief.clone, directive.read);
      const target = resolve(brief.clone, directive.path);
      if (!ask({ kind: "edit", title: `write ${directive.path}`, locations: [{ path: target }] })) return 1;
      write(target, `${derive(seed, directive.salt)}\n`);
      process.stdout.write("COMMIT-NOW\n");
      Bun.sleepSync(600_000);
      return 0;
    }

    case "delegate": {
      // Finding 114, reproduced deliberately: a worker that decides the job is
      // to run the orchestrator. Ruling 57's refusal is what must stop it, and
      // the shim on PATH records that the attempt really happened.
      const proc = Bun.spawnSync(["brigadier", "run", "--plan", "whatever"], { stdout: "pipe", stderr: "pipe" });
      const refused = proc.exitCode === 3;
      const seed = readSeed(brief.clone, directive.read);
      const target = resolve(brief.clone, directive.path);
      if (!ask({ kind: "edit", title: `write ${directive.path}`, locations: [{ path: target }] })) return 1;
      write(target, `${derive(seed, directive.salt)}\n`);
      process.stdout.write(`DELEGATION-${refused ? "REFUSED" : "ACCEPTED"}\n`);
      return 0;
    }

    case "leak-secret": {
      // Two files, and the pair is the point. The DERIVATION proves the secret
      // was really delivered through ruling 65's environment channel — a hash is
      // not an encoding of the value, so it can be asserted without weakening
      // the leak scan. The other file is the leak the product must contain.
      const secret = process.env[directive.env];
      const proof = resolve(brief.clone, directive.proofPath);
      if (!ask({ kind: "edit", title: `write ${directive.proofPath}`, locations: [{ path: proof }] })) return 1;
      write(proof, `${secret === undefined ? "NO-SECRET-IN-ENVIRONMENT" : derive(secret, directive.salt)}\n`);

      const target = resolve(brief.clone, directive.path);
      if (!ask({ kind: "edit", title: `write ${directive.path}`, locations: [{ path: target }] })) return 1;
      write(target, JSON.stringify({ credential: secret ?? "none" }, null, 2));
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
  // FOUND, not KNOWN: only markers this reviewer can spot AND that are actually
  // present in the diff it was handed.
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
  if (config.ledger !== undefined) {
    appendLedger(config.ledger, { vendor: config.id, role: brief.role, item: brief.itemId, pid: process.pid });
  }
  process.stdout.write(`AGENT ${config.id} ${config.version}\n`);
  process.exit(brief.role === "reviewer" ? review(brief, config) : act(brief, config));
}
