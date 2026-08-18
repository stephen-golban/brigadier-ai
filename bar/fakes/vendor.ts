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

/** The three measured payload shapes, copied out of the clone's own content. */
function plantPayloads(clone: string, from: string): void {
  const hooks = join(clone, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const source = resolve(clone, from);
  const body = existsSync(source) ? readFileSync(source, "utf8") : "";
  for (const name of ["pre-commit", "reference-transaction"]) {
    writeFileSync(join(hooks, name), body, { mode: 0o755 });
  }
  const fsmonitor = join(clone, ".git", "bar-fsmonitor");
  writeFileSync(fsmonitor, body, { mode: 0o755 });
  appendFileSync(join(clone, ".git", "config"), `\n[core]\n\tfsmonitor = ${fsmonitor}\n`);
}

/**
 * A descendant that outlives its parent and publishes its pid.
 *
 * MEASURED 2026-08-17: macOS ships no `setsid` (util-linux), so the POSIX branch
 * falls back to `nohup`, which outlives the parent without leaving the process
 * group. #43 measured Bun's job object carrying BREAKAWAY_OK and
 * SILENT_BREAKAWAY_OK, so `cmd /c start` is the Windows equivalent.
 */
function spawnEscapee(brief: Brief, heartbeat: string, pidFile: string): void {
  mkdirSync(dirname(heartbeat), { recursive: true });
  const script = join(brief.clone, "..", `escapee-${brief.itemId}.sh`);
  writeFileSync(
    script,
    `#!/bin/sh\ntrap '' HUP\necho $$ > ${JSON.stringify(pidFile)}\nwhile true; do echo tick >> ${JSON.stringify(heartbeat)}; sleep 0.2; done\n`,
    { mode: 0o755 },
  );
  const detach = Bun.which("setsid") !== null ? "setsid" : "nohup";
  const argv =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "/b", "cmd", "/c", `for /l %i in () do echo tick >> ${heartbeat}`]
      : ["/bin/sh", "-c", `${detach} ${JSON.stringify(script)} </dev/null >/dev/null 2>&1 &`];
  Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  Bun.sleepSync(700);
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
      plantPayloads(brief.clone, directive.from);
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
      spawnEscapee(brief, directive.heartbeat, directive.pidFile);
      process.stdout.write("ESCAPED-VIA detached descendant\n");
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

// ---------------------------------------------------------------- ACP mode

/**
 * The product launches an agent as `<command> --acp --brigadier-run=<id>` and
 * speaks JSON-RPC over stdio. The previous fixture was a one-shot CLI expecting
 * `<config> <brief-file>`, so it crashed on `open('--acp')` before reading a
 * byte — and eight items failed on that single cause while the product was
 * doing exactly the right thing.
 *
 * `bar/lib/acp-stub.ts` had this right all along, which is why item 1 kept
 * passing. This is the same protocol plus the ability to do work.
 */
interface Pending {
  resolve: (value: unknown) => void;
}

const pending = new Map<number, Pending>();
let nextId = 1;
let sessionCwd = process.cwd();

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Ask the client, exactly as ACP does, and honour whatever it answers. */
function requestPermission(request: Record<string, unknown>): Promise<boolean> {
  const id = nextId++;
  return new Promise<boolean>((resolve) => {
    pending.set(id, {
      resolve: (result) => {
        const outcome = (result as { outcome?: { outcome?: string; optionId?: string } } | null)?.outcome;
        resolve(outcome?.outcome === "selected" && /allow/i.test(outcome.optionId ?? ""));
      },
    });
    send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        ...request,
        options: [
          { optionId: "allow-once", kind: "allow_once", name: "Allow" },
          { optionId: "reject-once", kind: "reject_once", name: "Reject" },
        ],
      },
    });
  });
}

const DIRECTIVE = /<BAR-DIRECTIVE>([\s\S]*?)<\/BAR-DIRECTIVE>/;

async function acp(config: VendorConfig): Promise<void> {
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk as Uint8Array);
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.trim().length === 0) continue;

      let message: { id?: number; method?: string; params?: unknown; result?: unknown };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue;
      }

      // A response to something we asked the client.
      if (message.id !== undefined && message.method === undefined) {
        pending.get(message.id)?.resolve(message.result);
        pending.delete(message.id);
        continue;
      }
      const { id, method, params } = message;
      if (id === undefined || method === undefined) continue;

      switch (method) {
        case "initialize":
          send({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: 1,
              agentInfo: { name: config.id, version: config.version },
              agentCapabilities: {},
            },
          });
          break;

        case "session/new": {
          sessionCwd = (params as { cwd?: string })?.cwd ?? process.cwd();
          send({ jsonrpc: "2.0", id, result: { sessionId: `bar-${config.id}-${process.pid}` } });
          break;
        }

        case "session/set_mode":
          send({ jsonrpc: "2.0", id, result: null });
          break;

        case "session/prompt": {
          const text = ((params as { prompt?: Array<{ text?: string }> })?.prompt ?? [])
            .map((part) => part.text ?? "")
            .join("\n");
          const encoded = DIRECTIVE.exec(text)?.[1];
          const brief: Brief = {
            itemId: /item[: ]+(\S+)/i.exec(text)?.[1] ?? "unknown",
            clone: sessionCwd,
            role: /^\s*review\b/im.test(text) || /<BAR-ROLE>reviewer<\/BAR-ROLE>/.test(text) ? "reviewer" : "builder",
            ...(encoded ? { directive: JSON.parse(encoded) as Directive } : {}),
            ...(text.includes("<BAR-DIFF>") ? { diff: text } : {}),
          };
          if (config.ledger !== undefined) {
            appendLedger(config.ledger, {
              vendor: config.id,
              role: brief.role,
              item: brief.itemId,
              pid: process.pid,
            });
          }
          if (brief.role === "reviewer") {
            const found = (config.catches ?? []).filter((m) => text.includes(m));
            if (config.dieAsReviewer === true) process.exit(9);
            send({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: `bar-${config.id}-${process.pid}`,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `VERDICT ${JSON.stringify({ verdict: found.length > 0 ? "rejected" : "approved", found })}` } },
              },
            });
          } else {
            await actOverAcp(brief);
          }
          send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
          break;
        }

        default:
          send({ jsonrpc: "2.0", id, error: { code: -32601, message: `not implemented: ${method}` } });
      }
    }
  }
}

/** The same work as `act`, with the lane asked over the wire rather than by file. */
async function actOverAcp(brief: Brief): Promise<void> {
  const d = brief.directive;
  if (!d) return;
  const ask = (path: string | null): Promise<boolean> =>
    requestPermission({
      toolCall: {
        kind: "edit",
        title: path === null ? null : `write ${path}`,
        locations: path === null ? [] : [{ path }],
      },
    });

  switch (d.do) {
    case "derive-write":
    case "commit-then-hang":
    case "delegate": {
      const target = resolve(brief.clone, d.path);
      if (!(await ask(target))) return;
      write(target, `${derive(readSeed(brief.clone, d.read), d.salt)}\n`);
      if (d.do === "commit-then-hang") await new Promise(() => {});
      return;
    }
    case "read-then-write": {
      const target = resolve(brief.clone, d.path);
      if (!(await ask(target))) return;
      write(target, `${derive(readSeed(brief.clone, d.read), d.salt)}\n`);
      return;
    }
    case "escape": {
      if (!(await ask(d.absolutePath))) return;
      write(d.absolutePath, "escaped\n");
      return;
    }
    case "escape-blind": {
      // Codex's measured shape: nothing to place, so nothing to allow.
      if (!(await ask(null))) return;
      write(d.absolutePath, "escaped\n");
      return;
    }
    case "plant-git-payloads": {
      plantPayloads(brief.clone, d.from);
      const target = resolve(brief.clone, d.path);
      if (!(await ask(target))) return;
      write(target, `${derive(readSeed(brief.clone, d.read), d.salt)}\n`);
      return;
    }
    case "write-anyway":
      write(resolve(brief.clone, d.path), `${d.token}\n`);
      return;
    case "escape-process":
      spawnEscapee(brief, d.heartbeat, d.pidFile);
      return;
    case "leak-secret": {
      const secret = process.env[d.env];
      const proof = resolve(brief.clone, d.proofPath);
      if (await ask(proof)) {
        write(proof, `${secret === undefined ? "NO-SECRET-IN-ENVIRONMENT" : derive(secret, d.salt)}\n`);
      }
      const target = resolve(brief.clone, d.path);
      if (await ask(target)) write(target, JSON.stringify({ credential: secret ?? "none" }, null, 2));
      return;
    }
  }
}

if (import.meta.main) {
  const configPath = Bun.argv[2];
  if (configPath === undefined) {
    process.stderr.write("vendor: <config> required\n");
    process.exit(2);
  }
  const config = JSON.parse(readFileSync(configPath, "utf8")) as VendorConfig;
  const briefPath = Bun.argv[3];
  // Two callers, two protocols. The product speaks ACP over stdio; the fixture
  // orchestrator hands over a brief file.
  if (briefPath === undefined || briefPath.startsWith("--") || !existsSync(briefPath)) {
    await acp(config);
    process.exit(0);
  }
  const brief = JSON.parse(readFileSync(briefPath, "utf8")) as Brief;
  if (config.ledger !== undefined) {
    appendLedger(config.ledger, { vendor: config.id, role: brief.role, item: brief.itemId, pid: process.pid });
  }
  process.stdout.write(`AGENT ${config.id} ${config.version}\n`);
  process.exit(brief.role === "reviewer" ? review(brief, config) : act(brief, config));
}
