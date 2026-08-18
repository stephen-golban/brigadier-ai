// SPDX-License-Identifier: Apache-2.0
/**
 * Spawning an agent with BOTH markers on it, and keeping the pid.
 *
 * Ruling 38 and ruling 57 are two markers for two jobs, and conflating them
 * breaks one of the two:
 *
 *   `BRIGADIER_WORKER=<run-id>/<item>` in the ENVIRONMENT makes brigadier's own
 *   plugin inert inside the worker. A sweep reading `ps` cannot see it.
 *
 *   `--brigadier-run=<run-id>/<item>` in the COMMAND LINE is what ruling 38's
 *   reclamation sweep matches on. A binary reading `process.env` cannot see it.
 *
 * Both are set here, in one place, because the failure mode of setting one is
 * silent: a worker with only the environment marker is a worker the sweep will
 * never find, and nothing about the run looks different until an interrupt
 * leaves it running.
 *
 * WHY THIS EXISTS BESIDE `src/acp/channel.ts`. That module's `spawnChannel` is
 * the reference implementation of ACP's newline-delimited framing and this one
 * does not reimplement the framing — it wraps `Bun.spawn` for exactly two
 * things `spawnChannel` cannot give a caller: an argv the caller composed
 * (ruling 38's marker has to be IN it) and the child's pid (the run record's
 * `process-spawned` event is what a later sweep is told it should have
 * matched). The framing below is the same three rules — one JSON object per
 * line, trim, skip blanks — and any divergence between the two is a bug in this
 * file.
 *
 * THE HONEST LIMIT, and it is ruling 38's own: the command line is the
 * process's own memory. A vendor binary that re-`exec`s something else without
 * carrying the marker stops matching, and no sweep reading `ps` will find it
 * again. `SweepCoverage.completeness` says `not-proven` for exactly this
 * reason.
 */

import type { LineChannel } from "../acp/channel.ts";
import { RUN_MARKER_FLAG, WORKER_MARKER, workerMarkerValue } from "../agent/marker.ts";
import { buildEnvironment, type LaunchProfile } from "../agent/profiles.ts";
import { runMarkerArg } from "../run/marker.ts";
import type { WorkKind } from "../work/kind.ts";
import { RUN_ROOT_ENV } from "./refusal.ts";
import {
  chooseEffortModel,
  leverFor,
  noLever,
  switchState,
  type EffortOutcome,
  type EffortRequest,
} from "./effort.ts";

export interface MarkedSpawn {
  channel: LineChannel;
  pid: number;
  /** Exactly what a `ps` scan will see. Recorded so a sweep can be audited. */
  commandLine: string;
  /**
   * What was done about ruling 29's third axis, read AFTER the turn.
   *
   * A function rather than a value because the graded lever is answered on the
   * wire: `session/set_model` is sent while the handshake is in flight and the
   * agent's answer arrives later. Reading it at spawn time would record `sent`
   * for a setting that was subsequently refused.
   */
  effort(): EffortOutcome;
  kill(): void;
}

export interface MarkedSpawnOptions {
  profile: LaunchProfile;
  runId: string;
  item: number;
  /**
   * Ruling 59: where this run's directory is, so a REFUSED DELEGATION can find
   * the ledger to append itself to.
   *
   * The marker below says WHICH run and item; this says where that run lives.
   * Two variables rather than one longer marker value, because both marker
   * parsers split `<run-id>/<item>` on the last slash and a filesystem path is
   * nothing but slashes.
   */
  runRoot: string;
  /** The clone. The agent's working directory and its lane root. */
  cwd: string;
  kind: WorkKind;
  /** Decision 17's suppression lever: point the agent's config root here. */
  configRoot: string;
  /** Ruling 64: inside the item's own directory, never the shared temp root. */
  tmpDir: string;
  /** Ruling 65: granted at spawn, through the environment and nowhere else. */
  secrets?: Record<string, string>;
  /**
   * Ruling 31's derived effort. Derived from (kind, difficulty) by the caller,
   * never read from the plan, and already under ruling 30's ceiling.
   */
  effort: EffortRequest;
  /** Frames this module puts on the wire itself, so the transcript is complete. */
  onFrame?: (direction: "out" | "in", raw: string) => void;
}

/**
 * The id brigadier uses for the one request it sends outside `Connection`.
 *
 * A STRING, and that is the whole of why this is safe: `src/acp/connection.ts`
 * numbers its own requests from 1 and correlates them in a `Map<number, …>`, so
 * a string id cannot collide with one of its pending calls. The response is
 * swallowed here rather than passed through, so nothing above ever sees an id it
 * did not issue.
 */
export const EFFORT_REQUEST_ID = "brigadier-effort";

/**
 * Spawn one agent for one item.
 *
 * The marker is APPENDED to the profile's argv rather than inserted, so a
 * vendor that reads positional arguments sees them in the order its profile
 * measured. It is still an extra argument, and that is a real cost of ruling
 * 38: a vendor that rejects unknown arguments will fail to start, and it will
 * fail loudly at the handshake rather than silently mid-run.
 */
export function spawnMarkedAgent(options: MarkedSpawnOptions): MarkedSpawn {
  const marker = runMarkerArg(options.runId, options.item);
  const argv = [options.profile.command, ...options.profile.args, marker];
  const lever = leverFor(options.profile);

  // Ruling 40's switch half. Set BEFORE the process exists, because the lever is
  // an environment variable and there is no later moment at which it applies.
  // Two states, never four: `high` on a two-state lever is a word for something
  // MEASURED not to exist.
  const effortEnv: Record<string, string> = {};
  const outcome: { current: EffortOutcome } = {
    current:
      lever.kind === "none"
        ? noLever(options.effort, lever)
        : lever.kind === "switch"
          ? {
              requested: options.effort,
              asserted: switchState(options.effort),
              lever: `${lever.variable} at spawn`,
              disposition: "set-at-spawn",
              confirmed: false,
            }
          : {
              requested: options.effort,
              asserted: options.effort,
              lever: "session/set_model",
              disposition: "unavailable",
              confirmed: false,
              detail: "the agent had not answered session/new when this was recorded",
            },
  };
  if (lever.kind === "switch") {
    effortEnv[lever.variable] = options.effort === "low" ? lever.off : lever.on;
  }

  const env = buildEnvironment(options.profile, {
    configRoot: options.configRoot,
    kind: options.kind,
    tmpDir: options.tmpDir,
    restrictive: true,
    extra: {
      // Ruling 59 upgrades this from a boolean to an identity: a refused
      // delegation needs to know whose record to be written to.
      [WORKER_MARKER]: workerMarkerValue(options.runId, options.item),
      // And the identity alone is not enough to FIND that record. Without this
      // the refusal still stands — ruling 57's exit 3 is unconditional — and
      // `recordRefusal` reports `no-home`, which is the honest answer and is
      // also a run whose report can never say a delegation was attempted.
      [RUN_ROOT_ENV]: options.runRoot,
      ...effortEnv,
      ...(options.secrets ?? {}),
    },
  });

  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const errorChunks: string[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
        errorChunks.push(decoder.decode(chunk, { stream: true }));
      }
    } catch {
      // The stream tears down with the process; that is the normal exit path.
    }
  })();

  let closed = false;
  const channel: LineChannel = {
    send(line) {
      if (closed) return;
      child.stdin.write(`${line}\n`);
      child.stdin.flush();
    },
    async *lines() {
      const decoder = new TextDecoder();
      let buffered = "";
      try {
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
          buffered += decoder.decode(chunk, { stream: true });
          let newline = buffered.indexOf("\n");
          while (newline !== -1) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            newline = buffered.indexOf("\n");
            if (line) yield line;
          }
        }
      } catch {
        // Torn down by close(); the iteration simply ends.
      }
    },
    diagnostics() {
      return errorChunks.join("");
    },
    async close() {
      if (closed) return;
      closed = true;
      child.kill("SIGKILL");
      await child.exited;
    },
  };

  return {
    channel:
      lever.kind === "graded"
        ? gradedEffortChannel(channel, options.effort, outcome, options.onFrame)
        : channel,
    pid: child.pid,
    commandLine: argv.join(" "),
    effort: () => outcome.current,
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    },
  };
}

/** The flag a reader will see in `ps`, exported so a report can name it. */
export const MARKER_FLAG = RUN_MARKER_FLAG;

/**
 * Codex's graded lever, asserted on the wire.
 *
 * `session/set_model` is the only measured way to move Codex's effort (ruling
 * 40), and `Worker` exposes no way to send an arbitrary request — so the
 * request is put on the channel here, between the agent's answer to
 * `session/new` and the prompt that follows it. Three properties make that
 * safe rather than clever, and each is checked by a test:
 *
 *   THE ID IS A STRING. `Connection` numbers its own requests and correlates
 *   them in a `Map<number, …>`, so `"brigadier-effort"` cannot collide with a
 *   call it is waiting on.
 *
 *   THE ANSWER IS SWALLOWED. Nothing above this ever sees a response to an id
 *   it did not issue.
 *
 *   THE MODEL ID IS READ, NEVER CONSTRUCTED. The Codex profile's own caveat,
 *   and ruling 40 measured that an invalid id fails `-32603` — so the only
 *   strings sent are ones the agent itself listed at `session/new`.
 *
 * WHAT IT STILL DOES NOT ESTABLISH: that the effort asked for is the effort
 * that ran. #45 measured that neither vendor's setting is confirmable over the
 * protocol; an accepted id is an accepted id. `EffortOutcome.confirmed` stays
 * `false` on every path through this function.
 */
export function gradedEffortChannel(
  inner: LineChannel,
  request: EffortRequest,
  outcome: { current: EffortOutcome },
  onFrame?: (direction: "out" | "in", raw: string) => void,
): LineChannel {
  let asked = false;
  return {
    send: (line) => inner.send(line),
    diagnostics: () => inner.diagnostics(),
    close: () => inner.close(),
    async *lines() {
      for await (const line of inner.lines()) {
        const message = parseFrame(line);

        // Our own answer, and nobody else's business.
        if (message !== null && message["id"] === EFFORT_REQUEST_ID) {
          onFrame?.("in", line);
          const error = message["error"] as { message?: string } | undefined;
          outcome.current = error
            ? { ...outcome.current, disposition: "rejected", detail: error.message ?? "no message" }
            : { ...outcome.current, disposition: "accepted", asserted: outcome.current.asserted };
          continue;
        }

        if (!asked) {
          const result = message?.["result"] as { sessionId?: unknown } | undefined;
          const sessionId = result?.sessionId;
          if (typeof sessionId === "string" && sessionId.length > 0) {
            asked = true;
            const models = availableModels(result);
            const modelId = chooseEffortModel(models, request);
            if (modelId === null) {
              outcome.current = {
                ...outcome.current,
                disposition: "unavailable",
                detail:
                  `session/new listed ${models.length} model id(s) and none of them encodes an ` +
                  `effort at or below \`${request}\`. Ruling 30's ceiling is not exceeded to make ` +
                  "one fit, and an id is never constructed to invent one.",
              };
            } else {
              const frame = JSON.stringify({
                jsonrpc: "2.0",
                id: EFFORT_REQUEST_ID,
                method: "session/set_model",
                params: { sessionId, modelId },
              });
              inner.send(frame);
              onFrame?.("out", frame);
              outcome.current = { ...outcome.current, asserted: modelId, disposition: "sent" };
            }
          }
        }

        yield line;
      }
    },
  };
}

function parseFrame(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Both envelopes `src/agent/worker.ts` accepts, for the same reason it accepts
 * both: #2 measured only THAT the list arrives on Codex, not which envelope the
 * shipped bridge uses. An unrecognised shape yields an empty list, which becomes
 * `unavailable` rather than a guess.
 */
function availableModels(result: unknown): string[] {
  const holder = result as { models?: { availableModels?: unknown }; availableModels?: unknown } | null;
  const list = holder?.models?.availableModels ?? holder?.availableModels;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => (entry as { modelId?: unknown; id?: unknown } | null)?.modelId ?? (entry as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}
