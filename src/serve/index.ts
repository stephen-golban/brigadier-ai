// SPDX-License-Identifier: Apache-2.0
/**
 * `brigadier serve` — the server half of ruling 2's "ACP hub, client down and
 * server up".
 *
 * Everything else in `src/acp/` and `src/agent/` is brigadier speaking ACP
 * DOWNWARD, as the client of a vendor agent. This is the same protocol pointing
 * the other way: an editor (Zed, JetBrains) spawns this process and drives
 * brigadier exactly as brigadier drives Claude Code or Codex. It is the only
 * promise in ruling 2 that had no code behind it, and it gates none of BAR.md's
 * thirteen items — so it is built narrow and honest rather than broad.
 *
 * THE THREE THINGS THAT ARE NOT PROTOCOL. The protocol is the easy part.
 *
 * 1. ONE SINK, INCLUDING FOR FRAMES (ruling 65). Every JSON-RPC frame this
 *    server writes goes through the process's ONE `Sink` — the same object
 *    `src/cli.ts` builds at module scope before it can print anything — via the
 *    `writeLine` this module is handed. There is no second writer on stdout and
 *    there is nothing in `src/serve/` or `src/acp/stdio.ts` that
 *    `src/secrets/audit.ts` would find. That placement is not a compromise, it
 *    is the correct one: a frame is COMPOSED from run text and then
 *    JSON-escaped, so the sink sees the final bytes that are actually going on
 *    the wire, which is exactly ruling 65's rule about redacting after
 *    composition rather than before. The known limit is recorded elsewhere and
 *    is not repaired here: a secret containing a quote or a backslash is escaped
 *    once into an artifact and again into the frame, and ruling 65's four
 *    encodings do not compose.
 *
 *    The consequence, which is the reason the turn writes nothing directly: on
 *    stdout the sink is now the FRAME stream. Any line written to it that is not
 *    a JSON object would corrupt the protocol, so this server puts all human
 *    prose inside `session/update` frames and leaves warnings on stderr, where
 *    the sink already sends them and where the editor shows them as diagnostics.
 *
 * 2. ONE TURN AT A TIME, and the refusal is visible. `executeRun` is not
 *    reentrant and not multi-tenant: module-scope interrupt state, a run root it
 *    creates, the process's sink, process-wide signal registration. So
 *    `src/serve/handler.ts` serves one turn across all sessions and answers a
 *    second concurrent `session/prompt` with an error naming the session that
 *    holds it. `session/new` is unlimited, because sessions cost nothing; the
 *    limit is on work, which is where it can be explained.
 *
 *    The turn's closing sentence is on the same footing. `NOTHING_WAS_STARTED`
 *    is appended by `#deliver` in `src/serve/handler.ts` and by nothing else, so
 *    "the last line of every turn says so" is a property of the one exit rather
 *    than of five return sites each remembering. It was five sites, and a blind
 *    critic found the sixth on the real binary: a plan that made `validatePlan`
 *    throw answered `end_turn` and never said nothing had run, which an editor
 *    renders as a completed turn.
 *
 * 3. SIGNALS: THIS MODULE REGISTERS NONE, DELIBERATELY. Ruling 63 makes
 *    registering a handler a duty rather than a feature, and `src/cli.ts`
 *    already discharges it with one handler and one state machine. A server
 *    holds no run, so `initialState(false)`'s `idle` branch is already the right
 *    answer: the first interrupt has nothing to drain, and it restores `SIG_DFL`
 *    and RE-RAISES, so the editor's supervisor sees a genuine signal-terminated
 *    status rather than a number this file invented. `inFlight` is never called
 *    from here — there is no drain to enter, because there is no run in flight —
 *    which leaves ruling 63's second-interrupt-during-a-drain behaviour exactly
 *    as `run` set it up and unreachable from this command. When execution is
 *    wired, this is the seam that has to change, and it changes by passing
 *    `inFlight` down, not by registering a second handler.
 *
 * The server exits 0 when the client closes stdin. That is the normal end of an
 * editor session, not a failure — but a turn already running is DRAINED first,
 * under a deadline, because `Connection.close()` makes `notify` a no-op and
 * closing mid-turn would lose that turn's updates and its response.
 */

import { Connection } from "../acp/connection.ts";
import type { LineChannel } from "../acp/channel.ts";
import { stdioChannel } from "../acp/stdio.ts";
import type { BridgeOverride } from "../agent/drift.ts";
import { embeddedStamp } from "../build/identity.ts";
import { Server } from "./handler.ts";

export { ADMIT_STAGES, NOTHING_WAS_STARTED, admitPlan } from "./admit.ts";
export type { AdmitOutcome, AdmitRequest, AdmitStage, StageReporter } from "./admit.ts";
export { PROMPT_CONTRACT, PROTOCOL_VERSION, Server, TurnInFlight, UnknownSession, planPathFrom } from "./handler.ts";
export { TurnPlan, UnknownPlanEntry, type PlanEntry, type PlanEntryStatus } from "./plan.ts";

export const SERVE_USAGE = `  brigadier serve [--repo <path>] [--run-root <path>]
      Speak ACP on stdio as an AGENT, so an editor drives brigadier the way
      brigadier drives a vendor agent. Four methods — initialize, session/new,
      session/prompt, session/cancel — and -32601 to everything else.
      A prompt names a PLAN FILE (\`--plan <path>\` or a bare path); there is no
      planner, so English is not turned into a plan. The turn runs the whole of
      admission and STOPS: nothing is created and nothing is spent, and the last
      line of every turn says so — including a turn whose admission threw.
      Execution over ACP is not wired.
      ONE TURN AT A TIME across all sessions — a second concurrent
      session/prompt is answered with an error, because a run assumes one per
      process. Exits 0 when the client closes stdin.`;

/**
 * How long a turn already in flight is given after the client hangs up.
 *
 * Bounded rather than unbounded because "admission is fast" is a property of
 * today's pipeline, not a guarantee, and an exit path that can wait forever is
 * the hang that poisons whoever spawned us. Long enough that no admission of
 * any plan size reaches it.
 */
export const HANGUP_DRAIN_MS = 30_000;

export interface ServeOptions {
  /**
   * Where one composed frame goes. Ruling 65: pass the process's ONE `Sink`.
   * There is no default, because a default would be this module deciding to
   * write and that decision would then be invisible at the call site.
   */
  writeLine(line: string): void;
  /** The cwd a session inherits when the client names none. */
  cwd: string;
  runRoot?: string;
  overrides?: readonly BridgeOverride[];
  /** The byte source. Defaults to this process's stdin. */
  input?: ReadableStream<Uint8Array>;
  /** What `initialize` reports. Defaults to the compiled-in build stamp's commit. */
  version?: string;
  which?: (command: string) => string | null;
  /**
   * Diagnostics. Wired to the sink's STDERR, never its stdout — on stdout the
   * sink is the frame stream, and a line of prose there would corrupt the
   * protocol. Absent, a diagnostic is dropped rather than written, because this
   * module owns no stream of its own (ruling 65).
   */
  warn?(text: string): void;
}

/**
 * Serve until the client hangs up, then return 0.
 *
 * The channel is wrapped rather than `Connection` being changed, because
 * `Connection` needs nothing to serve — `#readLoop` already routes a frame with
 * both an `id` and a `method` to `onRequest` — and the only thing missing is a
 * way to know the far side has gone. `Connection` owns its read loop and does
 * not expose it, so the wrapper's `finally` on the iterator is the seam that
 * does not require editing a file this command does not own.
 */
export async function serveCommand(options: ServeOptions): Promise<number> {
  const base = stdioChannel({
    writeLine: options.writeLine,
    ...(options.input === undefined ? {} : { input: options.input }),
  });

  let hungUp!: () => void;
  const closed = new Promise<void>((resolve) => {
    hungUp = resolve;
  });

  const channel: LineChannel = {
    send: (line) => base.send(line),
    async *lines() {
      try {
        yield* base.lines();
      } finally {
        hungUp();
      }
    },
    diagnostics: () => base.diagnostics(),
    close: () => base.close(),
  };

  const server = new Server({
    notify: (method, params) => connection.notify(method, params),
    defaultCwd: options.cwd,
    ...(options.runRoot === undefined ? {} : { runRoot: options.runRoot }),
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    ...(options.which === undefined ? {} : { which: options.which }),
    version: options.version ?? serverVersion(),
  });

  const connection = new Connection(channel, {
    onRequest: server.onRequest,
    onNotification: server.onNotification,
  });

  await closed;
  // The client hung up. Let a turn already running finish writing, under a
  // deadline: `connection.close()` below makes `notify` a no-op, so closing
  // first would silently drop that turn's updates and its response.
  const drained = await Promise.race([
    server.whenIdle().then(() => "idle" as const),
    Bun.sleep(HANGUP_DRAIN_MS).then(() => "deadline" as const),
  ]);
  if (drained === "deadline") {
    options.warn?.(
      `! the client closed stdin while a turn was still running, and it did not finish within ${HANGUP_DRAIN_MS} ms. ` +
        "Its remaining frames are lost; nothing it started is still running, because this build's turn creates nothing.",
    );
  }
  await connection.close();
  return 0;
}

/**
 * What this artifact calls itself in the handshake.
 *
 * `embeddedStamp` and not `buildIdentity`: the full identity hashes the whole
 * executable, and `bar` item 10 grades this binary's start-up in milliseconds.
 * The handshake is on the start-up path and must not pay for a sixty-megabyte
 * read.
 */
function serverVersion(): string {
  const { stamp } = embeddedStamp();
  return stamp === null ? "0.0.0-unstamped" : `0.0.0+${stamp.commit.slice(0, 12)}`;
}
