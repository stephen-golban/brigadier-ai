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
import { exitWhenOrphaned } from "../lib/orphan.ts";
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
  // Overridable so a harness driving this fixture directly — item 9's control
  // spawn, which needs a KNOWN answer and no others — does not pay 30 s per
  // unanswered request. Default unchanged for every orchestrated caller.
  const budget = Number(process.env["BAR_ANSWER_DEADLINE_MS"] ?? "") || 30_000;
  const deadline = Date.now() + budget;
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
 * Commit, because the brief the product hands a real agent says to.
 *
 * MEASURED on this host on 2026-08-18: this fixture wrote files and never
 * committed them, and NINE of eleven live failures cascaded from that one
 * defect. Brigadier's own worker brief tells the agent *"When the work is done,
 * COMMIT IT... an uncommitted change is not part of your result"*, and ruling 56
 * forbids brigadier from running git inside a clone an agent has touched — so it
 * cannot commit on the worker's behalf. It therefore saw an empty diff and
 * integrated nothing, which is correct behaviour against a fixture that was not
 * behaving like the agent it stands in for. The product was right; the control
 * was not a control.
 *
 * Three flags, each for a reason this fixture created itself:
 *
 *   `--no-verify` and `core.fsmonitor=` — the `plant-git-payloads` directive
 *   deliberately fills `.git/hooks` and `core.fsmonitor` with arbitrary
 *   committed bytes. A commit that ran them would be the fixture executing its
 *   own attack payload, and the receipt would be lost to a hook that is not a
 *   script. `--no-verify` does NOT cover `reference-transaction`, so that
 *   directive also commits BEFORE it plants.
 *
 *   `user.email`/`user.name` on the command line — the clone belongs to the
 *   product and this fixture may not assume anything about its config. A worker
 *   that failed to commit because git had no identity would reproduce the exact
 *   silent-empty-diff failure this function exists to end.
 *
 * Failures are reported on stderr rather than swallowed: a fixture that cannot
 * commit must not look like an agent that chose not to.
 */
function commit(clone: string, message: string): void {
  const run = (args: string[]): { ok: boolean; err: string } => {
    try {
      const proc = Bun.spawnSync(
        [
          "git",
          "-c",
          "user.email=fixture@bar.invalid",
          "-c",
          "user.name=bar fixture",
          "-c",
          "core.fsmonitor=",
          "-c",
          "core.hooksPath=/nonexistent-bar-hooks",
          ...args,
        ],
        { cwd: clone, stdout: "pipe", stderr: "pipe" },
      );
      return { ok: proc.exitCode === 0, err: new TextDecoder().decode(proc.stderr).trim() };
    } catch (error) {
      return { ok: false, err: String(error) };
    }
  };
  const added = run(["add", "-A"]);
  if (!added.ok) process.stderr.write(`vendor: git add failed in ${clone}: ${added.err}\n`);
  const committed = run(["commit", "-q", "--no-verify", "-m", message]);
  if (!committed.ok && !/nothing to commit|nothing added/i.test(committed.err)) {
    process.stderr.write(`vendor: git commit failed in ${clone}: ${committed.err}\n`);
  }
}

export interface DelegationAttempt {
  /**
   * Three outcomes, not two. `unreachable` is the one that matters: a
   * `brigadier` that could not be spawned at all did not "accept" anything, and
   * reporting it as ACCEPTED would tell item 9 that the product failed to
   * refuse a call the product never saw. That is the same ambiguity ruling 57
   * warns about, one layer in.
   */
  outcome: "refused" | "accepted" | "unreachable";
  /** Exit code and output, or the reason the command could not be spawned. */
  detail: string;
}

/**
 * Attempt to run `brigadier`, the way a worker that decided to delegate would.
 *
 * Resolved through `PATH` and never as an absolute path, because that IS the
 * question. Ruling 57's one unmeasured assumption is whether `BRIGADIER_WORKER`
 * — and the `PATH` carrying brigadier's own shim — reaches the shell an agent
 * runs tool commands in, and item 9 is the thing scheduled to settle it. An
 * absolute path would answer a question nobody asked.
 *
 * A spawn that FAILS is reported rather than swallowed: "`brigadier` is not
 * resolvable from here" is a finding about environment propagation, and it is a
 * different finding from "the worker never tried".
 */
function spawnBrigadier(args: string[]): DelegationAttempt {
  try {
    const proc = Bun.spawnSync(["brigadier", ...args], { stdout: "pipe", stderr: "pipe" });
    const out = `${new TextDecoder().decode(proc.stdout)}${new TextDecoder().decode(proc.stderr)}`.trim();
    return {
      outcome: proc.exitCode === 3 ? "refused" : "accepted",
      detail: `exit ${proc.exitCode}: ${out.slice(0, 200)}`,
    };
  } catch (error) {
    // Written to stderr as well as returned: a worker that could not reach
    // `brigadier` at all is a finding about environment propagation, and it
    // must not be reachable only through a channel the caller might not read.
    const detail = `could NOT spawn \`brigadier\` from PATH: ${String(error)}`;
    process.stderr.write(`vendor: ${detail}\n`);
    return { outcome: "unreachable", detail };
  }
}

/**
 * The bytes `derive-and-carry` writes: the derived value, then the seed's
 * remaining lines verbatim.
 *
 * The FIRST line is the nonce and everything after it is carried. That split is
 * what makes the markers appear as ADDED lines in `git diff base..work` — they
 * are in a file the builder created — while the value the item verifies is still
 * a hash of something that exists only inside the clone.
 */
function carriedBody(seed: string, salt: string): string {
  const [nonceLine = "", ...rest] = seed.split("\n");
  return [derive(nonceLine, salt), ...rest].join("\n") + "\n";
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
    if (ask({ kind: "edit", title: "ambient", locations: [{ path: target }] })) {
      write(target, `${marker}\n`);
      commit(brief.clone, "obeyed the ambient instruction file");
    }
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
      commit(brief.clone, `write ${directive.path}`);
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
      const seed = readSeed(brief.clone, directive.read);
      const target = resolve(brief.clone, directive.path);
      if (!ask({ kind: "edit", title: "receipt", locations: [{ path: target }] })) return 1;
      write(target, `${derive(seed, directive.salt)}\n`);
      // Committed BEFORE the payloads are planted, deliberately. `--no-verify`
      // does not suppress `reference-transaction`, which this directive is
      // about to fill with arbitrary bytes — a commit after would run it.
      commit(brief.clone, `receipt for ${directive.path}`);
      plantPayloads(brief.clone, directive.from);
      return 0;
    }

    case "derive-and-carry": {
      const seed = readSeed(brief.clone, directive.read);
      const target = resolve(brief.clone, directive.path);
      if (!ask({ kind: "edit", title: `write ${directive.path}`, locations: [{ path: target }] })) return 1;
      write(target, carriedBody(seed, directive.salt));
      commit(brief.clone, `write ${directive.path}`);
      return 0;
    }

    case "read-then-write": {
      // Ruling 54: wave 2 must SEE wave 1's output. The value it needs existed
      // only in wave 1's integration commit, never in the plan.
      const seen = readSeed(brief.clone, directive.read);
      const target = resolve(brief.clone, directive.path);
      if (!ask({ kind: "edit", title: `write ${directive.path}`, locations: [{ path: target }] })) return 1;
      write(target, `${derive(seen, directive.salt)}\n`);
      commit(brief.clone, `write ${directive.path}`);
      return 0;
    }

    case "write-anyway": {
      // Ruling 49: a read-only item's directory is never read back, so this must
      // reach neither the branch nor any report. The agent is not stopped here —
      // three of five measured vendors give no lane at all.
      write(resolve(brief.clone, directive.path), `${directive.token}\n`);
      // Committed too: a real agent that decided to write would also commit,
      // and an UNCOMMITTED file could be absent from the branch for a reason
      // that has nothing to do with the product honouring ruling 49.
      commit(brief.clone, `wrote ${directive.path} in a read-only checkout`);
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
      commit(brief.clone, `write ${directive.path}`);
      process.stdout.write("COMMIT-NOW\n");
      Bun.sleepSync(600_000);
      return 0;
    }

    case "delegate": {
      // Finding 114, reproduced deliberately: a worker that decides the job is
      // to run the orchestrator. Ruling 57's refusal is what must stop it, and
      // the shim on PATH records that the attempt really happened.
      const attempt = spawnBrigadier(["run", "--plan", "whatever"]);
      const seed = readSeed(brief.clone, directive.read);
      const target = resolve(brief.clone, directive.path);
      if (!ask({ kind: "edit", title: `write ${directive.path}`, locations: [{ path: target }] })) return 1;
      write(target, `${derive(seed, directive.salt)}\n`);
      commit(brief.clone, `write ${directive.path}`);
      process.stdout.write(`DELEGATION-${attempt.outcome.toUpperCase()} (${attempt.detail})\n`);
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
      // ─────────── AND THE SAME VALUE AGAIN, AT ONE ESCAPE LEVEL ───────────
      //
      // The JSON copy above is kept, and this is not redundancy. `config.json`
      // holds the value JSON-escaped because it is JSON; by the time a diff of
      // that file rides inside a transcript frame it has been escaped TWICE, and
      // `src/secrets/redact.ts` enumerates four flat encodings of which
      // "escaped twice" is not one. The sink cannot act on what it cannot
      // recognise, so with only that copy on the wire DELETING RULING 65'S SINK
      // ALTOGETHER CHANGES NOTHING OBSERVABLE — the fixture cannot fail the
      // check it is a fixture to, which is the shape that let a redaction sink
      // be deleted with every item still green.
      //
      // A plain file carries the value at ONE escape level, which is the form
      // the sink enumerates and therefore the form whose placeholder is
      // observable. The doubly-escaped copy stays beside it as evidence of the
      // documented limit: item 12 reports it as an honest bound on ruling 65
      // rather than as a product failure.
      write(resolve(brief.clone, "credential.txt"), `${secret ?? "none"}\n`);
      commit(brief.clone, `write ${directive.proofPath} and ${directive.path}`);
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

/**
 * How long an outstanding `session/request_permission` may go unanswered.
 *
 * Unbounded was the wrong answer for the same reason the deadlock below was:
 * the least informative failure available is a process that stops with no
 * account of why. An expiry is DENY — a denial writes nothing, so a lost answer
 * degrades to "the lane refused" rather than to a wedged turn — and it says so
 * on stderr, which the harness captures.
 */
const PERMISSION_DEADLINE_MS = 120_000;

/** Ask the client, exactly as ACP does, and honour whatever it answers. */
function requestPermission(request: Record<string, unknown>): Promise<boolean> {
  const id = nextId++;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      process.stderr.write(`vendor: no answer to request ${id} within ${PERMISSION_DEADLINE_MS}ms; treating as DENY\n`);
      resolve(false);
    }, PERMISSION_DEADLINE_MS);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
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

/**
 * Handling runs OFF the read loop, and that separation is the whole fix.
 *
 * MEASURED on this host on 2026-08-18: the previous shape `await`ed
 * `actOverAcp` inside the body of `for await (… Bun.stdin.stream())`. While its
 * own `session/request_permission` was outstanding the fixture had therefore
 * stopped reading stdin — and the client's reply to that very request arrives
 * on stdin. The classic request/response deadlock: the only thing able to
 * receive the answer is blocked waiting for it. Every `--live` run then died on
 * the harness deadline with no report written at all, and six items were
 * recorded as product defects that the product had not committed.
 *
 * So the reader only parses and dispatches. Responses to our own outbound
 * requests are settled inline — they are a map lookup, they cannot block.
 * Everything else is handed to one of two dispatchers and the loop goes
 * straight back to the pipe.
 *
 * TURNS are serialised, because that is where the protocol needs an order: a
 * session may only be doing one thing at a time, and two `session/prompt`s
 * interleaving would let one turn's permission answer settle the other's
 * request. HANDSHAKE and control methods are not chained behind them, because
 * a turn is allowed to take a long time — `commit-then-hang` is SUPPOSED to
 * never finish — and a fixture that could no longer answer `initialize` while
 * a turn was in flight would have swapped one wedge for another.
 */
let turnTail: Promise<void> = Promise.resolve();
let queueDepth = 0;

function track(work: Promise<void>): void {
  queueDepth += 1;
  void work
    .catch((error: unknown) => {
      process.stderr.write(`vendor: handler failed: ${String(error)}\n`);
    })
    .finally(() => {
      queueDepth -= 1;
    });
}

/** Off the loop, in order with every other turn. */
function dispatchInTurnOrder(handler: () => Promise<void>): void {
  turnTail = turnTail.then(handler, handler);
  track(turnTail);
}

/** Off the loop, immediately — never queued behind a turn. */
function dispatchNow(handler: () => Promise<void>): void {
  track(
    (async () => {
      await handler();
    })(),
  );
}

/**
 * Wait for dispatched work to finish, but never forever.
 *
 * One directive (`commit-then-hang`) is SUPPOSED to hang, so the chain can
 * legitimately never settle. Anything downstream of an unbounded wait on it —
 * the exit, and with it every `finally` the runtime would run — would simply
 * never happen, which is the same class of bug as the deadlock above wearing a
 * different hat. Bounded, and the caller proceeds either way.
 */
async function drain(budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (queueDepth > 0 && Date.now() < deadline) await Bun.sleep(10);
  return queueDepth === 0;
}

const DIRECTIVE = /<BAR-DIRECTIVE>([\s\S]*?)<\/BAR-DIRECTIVE>/;

/**
 * One inbound request, answered. Never called from the read loop directly —
 * always through a dispatcher, so an `await` in here cannot stall the reader.
 */
async function handleRequest(
  config: VendorConfig,
  id: number,
  method: string,
  params: unknown,
): Promise<void> {
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
      return;

    case "session/new": {
      sessionCwd = (params as { cwd?: string })?.cwd ?? process.cwd();
      send({ jsonrpc: "2.0", id, result: { sessionId: `bar-${config.id}-${process.pid}` } });
      return;
    }

    case "session/set_mode":
      send({ jsonrpc: "2.0", id, result: null });
      return;

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
      return;
    }

    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `not implemented: ${method}` } });
  }
}

/**
 * The read loop. It parses, it routes, and it does not await anything that
 * could depend on a byte it has not read yet — see `dispatch` above.
 */
async function acp(config: VendorConfig): Promise<void> {
  // A long-lived stdio process, so it must be able to notice that the thing it
  // is talking to has died. See `bar/lib/orphan.ts`.
  exitWhenOrphaned("vendor");
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

      // A response to something we asked the client. Settled inline: it is a
      // map lookup, and it is the message a dispatched handler is waiting for.
      if (message.id !== undefined && message.method === undefined) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        waiter?.resolve(message.result);
        continue;
      }
      const { id, method, params } = message;
      if (id === undefined || method === undefined) continue;

      const handle = (): Promise<void> => handleRequest(config, id, method, params);
      if (method === "session/prompt") dispatchInTurnOrder(handle);
      else dispatchNow(handle);
    }
  }

  // stdin closed: the client is gone, so nothing outstanding can ever be
  // answered. Give dispatched work a bounded moment to finish and return.
  await drain(5_000);
}

/**
 * The same work as `act`, with the lane asked over the wire rather than by file.
 *
 * Two defects were measured in here on 2026-08-18 and both made the harness
 * report the product's behaviour as its own:
 *
 *   **`delegate` was folded in with `derive-write` and never called
 *   `brigadier`.** Item 9's shim ledger therefore came back completely empty on
 *   a live run — and an empty ledger is ambiguous in exactly the way ruling 57
 *   warns about: it reads the same whether the worker never tried to delegate
 *   (the product working) or the shim was never reachable (the harness
 *   measuring nothing). It was neither. The fixture never attempted the call.
 *
 *   **The ambient instruction file was never read.** `act` reads it; this path
 *   did not. So "the marker is absent from the merged tree" was true for a
 *   fixture that had never looked, and route 1 of finding 114 passed
 *   vacuously — a check that reports success when the thing it checks did not
 *   happen, which is the shape `BAR.md` opens by naming.
 *
 * Everything that writes inside the clone now COMMITS, for the reason `commit`
 * above records at length.
 */
async function actOverAcp(brief: Brief): Promise<void> {
  const ask = (path: string | null): Promise<boolean> =>
    requestPermission({
      toolCall: {
        kind: "edit",
        title: path === null ? null : `write ${path}`,
        locations: path === null ? [] : [{ path }],
      },
    });

  // Route 1 of finding 114, read exactly as `act` reads it. An agent under a
  // redirected config root finds nothing here; one under the operator's own
  // `HOME` finds the file and obeys it.
  const marker = ambientMarker();
  if (marker !== undefined) {
    const ambientTarget = resolve(brief.clone, "ambient-obeyed.txt");
    if (await ask(ambientTarget)) {
      write(ambientTarget, `${marker}\n`);
      commit(brief.clone, "obeyed the ambient instruction file");
    }
  }

  const d = brief.directive;
  if (!d) return;

  switch (d.do) {
    case "derive-write":
    case "commit-then-hang": {
      const target = resolve(brief.clone, d.path);
      if (!(await ask(target))) return;
      write(target, `${derive(readSeed(brief.clone, d.read), d.salt)}\n`);
      commit(brief.clone, `write ${d.path}`);
      // The commit is BEFORE the hang on purpose: item 7 needs an interrupted
      // clone that really has work in it, retained rather than deleted.
      if (d.do === "commit-then-hang") await new Promise(() => {});
      return;
    }
    case "delegate": {
      // Finding 114, reproduced deliberately: a worker that decides the job is
      // to run the orchestrator. Ruling 57's refusal is what must stop it, and
      // the shim on PATH records that the attempt really happened — which is
      // the whole of item 9's route 2 and the only positive that makes an empty
      // ledger mean anything.
      const attempt = spawnBrigadier(["run", "--plan", "whatever"]);
      const target = resolve(brief.clone, d.path);
      if (!(await ask(target))) return;
      write(target, `${derive(readSeed(brief.clone, d.read), d.salt)}\n`);
      commit(brief.clone, `write ${d.path}`);
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: `bar-worker-${process.pid}`,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `DELEGATION-${attempt.outcome.toUpperCase()} (${attempt.detail})` },
          },
        },
      });
      return;
    }
    case "derive-and-carry": {
      const target = resolve(brief.clone, d.path);
      if (!(await ask(target))) return;
      write(target, carriedBody(readSeed(brief.clone, d.read), d.salt));
      commit(brief.clone, `write ${d.path}`);
      return;
    }
    case "read-then-write": {
      const target = resolve(brief.clone, d.path);
      if (!(await ask(target))) return;
      write(target, `${derive(readSeed(brief.clone, d.read), d.salt)}\n`);
      commit(brief.clone, `write ${d.path}`);
      return;
    }
    case "escape": {
      if (!(await ask(d.absolutePath))) return;
      // Outside the clone by construction, so there is nothing to commit.
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
      const target = resolve(brief.clone, d.path);
      if (!(await ask(target))) return;
      write(target, `${derive(readSeed(brief.clone, d.read), d.salt)}\n`);
      // Committed before planting — see the note in `act`.
      commit(brief.clone, `receipt for ${d.path}`);
      plantPayloads(brief.clone, d.from);
      return;
    }
    case "write-anyway":
      write(resolve(brief.clone, d.path), `${d.token}\n`);
      commit(brief.clone, `wrote ${d.path} in a read-only checkout`);
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
      // The same pair as the CLI branch above, for the same reason: the JSON
      // copy is escaped twice by the time a diff of it reaches a frame, and no
      // enumerated encoding matches it. See the comment there — a fixture whose
      // only leak is invisible to the sink cannot show the sink firing, and
      // cannot show it missing either.
      write(resolve(brief.clone, "credential.txt"), `${secret ?? "none"}\n`);
      commit(brief.clone, `write ${d.proofPath} and ${d.path}`);
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
