// SPDX-License-Identifier: Apache-2.0
/**
 * brigadier as an ACP AGENT: the mirror image of `Worker.#serve`.
 *
 * `src/agent/worker.ts` answers the three client→agent methods a vendor asks of
 * us and rejects everything else with -32601. This answers the four
 * agent-facing methods an editor asks of us and rejects everything else the same
 * way, over the same `Connection` — which needs no change to serve, because
 * `#readLoop` already classifies a frame carrying BOTH an `id` and a `method` as
 * an inbound request and hands it to `options.onRequest`.
 *
 * FOUR METHODS, AND THAT IS THE WHOLE SURFACE. `initialize`, `session/new`,
 * `session/prompt`, `session/cancel`. MEASURED against `Zed 1.15.0` on ticket
 * #48: answering -32601 to everything else broke nothing — the 24 unimplemented
 * methods were never missed. A narrow server that is honest about its limits
 * beats a broad one that pretends.
 *
 * ONE TURN AT A TIME, ACROSS ALL SESSIONS, AND THE REFUSAL IS AN ERROR RESPONSE
 * RATHER THAN A QUEUE. This is not a protocol limitation, it is brigadier's:
 * `executeRun` assumes one run per process — module-scope interrupt state, a run
 * root it creates, the process's one sink, process-wide signal registration —
 * and an editor will happily open several sessions. Queueing the second prompt
 * would make a client wait an unbounded time with no way to see why; a
 * concurrency the product does not have, silently faked, is worse than a
 * refusal. So the second concurrent `session/prompt` is answered with an error
 * naming the session that holds the turn.
 *
 * SESSIONS ARE CHEAP AND UNLIMITED; TURNS ARE NOT. `session/new` always
 * succeeds. The limit is on work, and putting it there is what makes the error
 * message able to name what is actually in the way.
 */

import { MethodNotFound } from "../acp/connection.ts";
import type { BridgeOverride } from "../agent/drift.ts";
import {
  ADMIT_STAGES,
  NOTHING_WAS_STARTED,
  admitPlan,
  type AdmitOutcome,
  type AdmitRequest,
  type AdmitStage,
} from "./admit.ts";
import { TurnPlan } from "./plan.ts";

/**
 * MEASURED against `Zed 1.15.0` on ticket #48: this is the version the probe
 * handshook with and the version every vendor bridge in `src/agent/` speaks.
 */
export const PROTOCOL_VERSION = 1;

/** A second `session/prompt` arrived while one was already running. */
export class TurnInFlight extends Error {
  constructor(readonly holder: string) {
    super(
      `brigadier is already running a turn for session ${holder}, and it serves one at a time. ` +
        "This is brigadier's limit and not the protocol's: a run assumes one per process — one run root, " +
        "one sink, one signal handler — so a second concurrent turn would be a concurrency the product " +
        "does not have. Wait for that turn to finish, or send `session/cancel` for it.",
    );
    this.name = "TurnInFlight";
  }
}

export class UnknownSession extends Error {
  constructor(sessionId: string) {
    super(`unknown session ${JSON.stringify(sessionId)} — call session/new first`);
    this.name = "UnknownSession";
  }
}

interface SessionState {
  cwd: string;
  cancelled: boolean;
}

/**
 * What a turn produced, BEFORE anything is said to the client.
 *
 * `#turnFor` returns one of these and emits no prose at all. That is the whole
 * of the fix for a defect a blind critic found on the real binary: an admission
 * that THREW answered `stopReason: "end_turn"` and never said that nothing had
 * been started, because the sentence was hand-appended at five separate return
 * sites in `src/serve/admit.ts` and the catch arm was a sixth site that nobody
 * had remembered. An editor rendered that as a completed turn.
 *
 * A property that holds because five sites each remembered is not a property.
 * So no path can emit the closing prose, because no path emits prose: every
 * terminal outcome of every path — no plan path, admission threw, refused,
 * admitted, cancelled — returns one of these and `#deliver` is the single place
 * that turns it into frames. A sixth return site added here cannot regress it,
 * because the type gives it nowhere to answer from.
 */
interface TurnOutcome {
  readonly lines: readonly string[];
  readonly stopReason: "end_turn" | "cancelled";
}

export interface ServerOptions {
  /** Wired to `Connection.notify`. The server never writes a frame itself. */
  notify(method: string, params: unknown): void;
  /** Where a `session/new` that names no cwd runs. */
  defaultCwd: string;
  runRoot?: string;
  overrides?: readonly BridgeOverride[];
  /** What `initialize` reports as this agent's version. */
  version: string;
  /** Injected so a test can drive a turn without touching PATH or the filesystem. */
  admit?: typeof admitPlan;
  /** Injected for the same reason: `agentsOnPath` resolution. */
  which?: (command: string) => string | null;
}

export class Server {
  #sessions = new Map<string, SessionState>();
  #turn: string | null = null;
  #inFlight: Promise<unknown> | null = null;
  #counter = 0;

  constructor(private readonly options: ServerOptions) {}

  /** The session currently holding the one turn, or `null`. For tests and diagnostics. */
  get busyWith(): string | null {
    return this.#turn;
  }

  /**
   * Resolves when no turn is running.
   *
   * The client hanging up is not a reason to drop a turn's remaining frames on
   * the floor: `Connection.close()` makes `notify` a no-op, so closing while a
   * turn is mid-flight loses its `session/update`s AND its response. Waiting is
   * cheap because the turn is already bounded; the CALLER bounds this wait as
   * well, because "already bounded" is a property of today's pipeline rather
   * than a guarantee.
   */
  async whenIdle(): Promise<void> {
    while (this.#inFlight !== null) {
      try {
        await this.#inFlight;
      } catch {
        // The turn already told the client. Nothing here is a second chance.
      }
    }
  }

  /**
   * Client→agent requests. Anything not here throws `MethodNotFound`, which
   * `Connection` turns into -32601.
   */
  onRequest = async (method: string, params: unknown): Promise<unknown> => {
    switch (method) {
      case "initialize":
        return this.#initialize();

      case "session/new":
        return this.#newSession(params);

      case "session/prompt":
        return this.#prompt(params);

      // A notification in ACP, so this arm is defence rather than the main path:
      // a client that sends it as a request gets the same effect and a `null`
      // result instead of silence.
      case "session/cancel":
        this.#cancel(params);
        return null;

      default:
        throw new MethodNotFound(method);
    }
  };

  /** Client→agent notifications. `session/cancel` is the only one that means anything here. */
  onNotification = (method: string, params: unknown): void => {
    if (method === "session/cancel") this.#cancel(params);
  };

  #initialize(): unknown {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "brigadier", title: "brigadier", version: this.options.version },
      agentCapabilities: {
        // Every one of these is `false` because it is `false`, not because it is
        // unimplemented and unadvertised. A session cannot be loaded because
        // nothing is persisted per session; a prompt carries text because a plan
        // path is text.
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
    };
  }

  #newSession(params: unknown): unknown {
    const cwd = (params as { cwd?: string } | undefined)?.cwd;
    const sessionId = `brigadier-${++this.#counter}`;
    this.#sessions.set(sessionId, {
      cwd: typeof cwd === "string" && cwd.length > 0 ? cwd : this.options.defaultCwd,
      cancelled: false,
    });
    return { sessionId };
  }

  #cancel(params: unknown): void {
    const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
    if (typeof sessionId !== "string") return;
    const session = this.#sessions.get(sessionId);
    if (session) session.cancelled = true;
  }

  async #prompt(params: unknown): Promise<unknown> {
    const { sessionId, prompt } = (params ?? {}) as { sessionId?: string; prompt?: unknown };
    if (typeof sessionId !== "string" || !this.#sessions.has(sessionId)) {
      throw new UnknownSession(String(sessionId));
    }
    if (this.#turn !== null) throw new TurnInFlight(this.#turn);

    const session = this.#sessions.get(sessionId)!;
    session.cancelled = false;
    this.#turn = sessionId;
    const running = this.#deliver(sessionId, session, promptText(prompt));
    this.#inFlight = running;
    try {
      return await running;
    } finally {
      // In `finally` and not after the return: a turn that threw must not leave
      // the server permanently refusing every future prompt with `TurnInFlight`.
      this.#turn = null;
      this.#inFlight = null;
    }
  }

  /**
   * The single exit of every turn, and the only place its prose is composed.
   *
   * `NOTHING_WAS_STARTED` is appended HERE and nowhere else, so the guarantee is
   * structural rather than reviewed: it covers every return site `#turnFor` has
   * today and every one it will ever have, including the catch arm, because
   * `#turnFor` cannot answer the client at all.
   */
  async #deliver(sessionId: string, session: SessionState, text: string): Promise<unknown> {
    const outcome = await this.#turnFor(sessionId, session, text);
    this.#say(sessionId, `${[...outcome.lines, NOTHING_WAS_STARTED].join("\n")}\n`);
    return { stopReason: outcome.stopReason };
  }

  async #turnFor(sessionId: string, session: SessionState, text: string): Promise<TurnOutcome> {
    const planPath = planPathFrom(text);
    if (planPath === null) return { lines: [PROMPT_CONTRACT], stopReason: "end_turn" };

    // The ACP plan, published before the first stage and re-published whole on
    // every transition. See `src/serve/plan.ts` for why it is never a
    // `plan_update` and never derived from an index.
    const plan = new TurnPlan([...ADMIT_STAGES]);
    const publish = (): void => {
      this.#update(sessionId, { sessionUpdate: "plan", entries: plan.entries() });
    };
    publish();

    const admit = this.options.admit ?? admitPlan;
    const request: AdmitRequest = {
      planPath,
      repo: session.cwd,
      ...(this.options.runRoot === undefined ? {} : { runRoot: this.options.runRoot }),
      ...(this.options.overrides === undefined ? {} : { overrides: this.options.overrides }),
      ...(this.options.which === undefined ? {} : { which: this.options.which }),
    };

    let outcome: AdmitOutcome;
    try {
      outcome = await admit(request, {
        start: (stage: AdmitStage) => {
          plan.start(stage);
          publish();
        },
        finish: (stage: AdmitStage) => {
          plan.finish(stage);
          publish();
        },
        // The `await` here is what lets the read loop deliver a `session/cancel`
        // that arrived while the previous stage was running.
        keepGoing: async () => {
          await Promise.resolve();
          return !session.cancelled;
        },
      });
    } catch (error) {
      // An admission that threw is brigadier's fault, not the client's, and the
      // client is owed the reason as prose rather than a dead turn. The plan is
      // deliberately NOT re-published: it stays frozen showing exactly how far
      // the turn got, which is the honest picture of a pipeline that stopped.
      return {
        lines: [`admission failed: ${error instanceof Error ? error.message : String(error)}`],
        stopReason: "end_turn",
      };
    }

    publish();
    return { lines: outcome.lines, stopReason: outcome.cancelled ? "cancelled" : "end_turn" };
  }

  #say(sessionId: string, text: string): void {
    this.#update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }

  #update(sessionId: string, update: unknown): void {
    this.options.notify("session/update", { sessionId, update });
  }
}

/**
 * What the prompt has to contain, said in full the first time it does not.
 *
 * brigadier has no planner and does not pretend to have one: `parsePlan` reads a
 * JSON plan the operator wrote. Guessing one from English would be inventing the
 * input to every refusal, fan-out and cost decision downstream of it.
 */
export const PROMPT_CONTRACT =
  "brigadier's ACP server takes a PLAN FILE, not a task description. Send `--plan <path>` or a bare path to a " +
  "plan JSON file; a path relative to the session's cwd is resolved against it.\n" +
  "There is no planner in this build, so a prompt in English cannot be turned into a plan without inventing " +
  "the input to every refusal, fan-out and cost decision the plan drives.\n" +
  "The turn then runs the whole of admission — exactly what `brigadier plan` decides — and stops there.";

/** Every text block in the prompt, joined. Non-text blocks are ignored; `promptCapabilities` says so. */
function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => (block as { text?: unknown })?.text)
    .filter((text): text is string => typeof text === "string")
    .join(" ");
}

/**
 * The plan path in a prompt, or `null`.
 *
 * `--plan <path>` first because that is what the CLI takes and an operator who
 * types the flag out of habit should not be told the flag is wrong. Otherwise a
 * bare single token, which is the shape of someone dragging a file in. Anything
 * else is `null` and gets `PROMPT_CONTRACT` — deliberately not a guess: picking
 * the first thing that looks path-shaped out of a sentence is how a server ends
 * up admitting a file the operator did not name.
 */
export function planPathFrom(text: string): string | null {
  const tokens = text.trim().split(/\s+/).filter((token) => token.length > 0);
  const flag = tokens.indexOf("--plan");
  if (flag !== -1) {
    const next = tokens[flag + 1];
    return next !== undefined && !next.startsWith("--") ? next : null;
  }
  return tokens.length === 1 && !tokens[0]!.startsWith("--") ? tokens[0]! : null;
}
