// SPDX-License-Identifier: Apache-2.0
/**
 * A worker: one agent, one session, one lane.
 *
 * This is the seam the rest of brigadier is built on. Behind four methods sit
 * process spawn, JSON-RPC in both directions, six vendors' launch quirks, the
 * permission-payload variance of #3 and #50, filesystem requests, usage
 * extraction, and per-vendor compaction detection. Nothing above this module
 * has to know that ACP exists.
 *
 * What a caller must know beyond the type signature:
 *
 *   - `start()` performs BOTH detection steps. Ruling 41: every agent measured
 *     completes `initialize` while unauthenticated and fails one step later at
 *     `session/new`, so a handshake alone means *present*, not *usable*. If
 *     `start()` resolves, the agent is usable; if it throws, the message is the
 *     vendor's own and is usually actionable.
 *
 *   - `prompt()` NEVER throws for a task-level failure. It resolves with a Turn
 *     whose `stopReason` is whatever the agent said. #14 measured that
 *     `end_turn` does NOT mean the task was done, so callers must judge the
 *     work, not the stop reason.
 *
 *   - The lane is enforced HERE, in the client, on every permission request.
 *     That is the property decision 2 buys and ruling 43 qualifies.
 */

import { spawnChannel, type LineChannel } from "../acp/channel.ts";
import { Connection, MethodNotFound } from "../acp/connection.ts";
import { Lane, type Verdict } from "../lane/lane.ts";
import type { WorkKind } from "../work/kind.ts";
import { laneFailureBlocks } from "./drift.ts";
import { buildEnvironment, laneModeFor, type LaunchProfile } from "./profiles.ts";

export interface ToolCallRecord {
  id?: string;
  kind?: string;
  title?: string | null;
  status?: string;
}

export interface PermissionRecord {
  kind?: string;
  title?: string | null;
  verdict: Verdict;
}

export interface Usage {
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
}

export interface Turn {
  /** Whatever the agent reported. NOT a judgement about the work (#14). */
  stopReason: string;
  /** Concatenated `agent_message_chunk` text. */
  text: string;
  toolCalls: ToolCallRecord[];
  permissions: PermissionRecord[];
  /** Present only on vendors that emit `usage_update` — three of six (#46). */
  usage?: Usage;
  /**
   * Best-effort, and deliberately per-vendor. On Qwen the only signal is an
   * English sentence in a message chunk (#47); on Claude and Codex the event
   * never reaches ACP at all, so `false` here means "nothing observable",
   * not "did not happen".
   */
  compactionObserved: boolean;
  /** Agent→client bytes. The token volume of a turn is itself a measurement. */
  bytes: number;
}

export interface WorkerOptions {
  /** Absolute path. Becomes `session/new`'s cwd and the lane root. */
  cwd: string;
  lane: Lane;
  /**
   * Ruling 49. Selects the vendor mode asserted at spawn, and it is not
   * cosmetic: Codex's `read-only` blocks writes at the OS level and its `agent`
   * does not (#41). Defaults to `write`. A `read-only` caller must also pass a
   * lane built with `lanePolicyFor("read-only")` — the two halves are separate
   * because only one of them exists on every vendor.
   */
  kind?: WorkKind;
  /** Point the agent's config root here to suppress ambient instructions (decision 17). */
  configRoot?: string;
  /** Assert the restrictive mode where the vendor offers one. Default true. */
  restrictive?: boolean;
  /** Every frame, for the run transcript. */
  onFrame?: (direction: "out" | "in", raw: string) => void;
  /** Override the channel. Tests pass a memory channel; production spawns. */
  channel?: LineChannel;
}

/** Qwen announces compaction only as prose. This is the shape it uses (#47). */
const COMPACTION_PROSE = /compressed from:\s*\d+\s*to\s*\d+\s*tokens|approached the input token limit/i;

/** What `session/new` answers with. `models` arrives on Codex alone (#2). */
interface SessionNew {
  sessionId?: string;
  models?: { availableModels?: unknown };
  availableModels?: unknown;
}

/**
 * The model ids a session offered, read out of `availableModels`.
 *
 * Both envelopes are accepted — `models.availableModels` and a bare
 * `availableModels` — because #2 measured only THAT the list arrives on Codex
 * and that ids must be read rather than constructed; which of the two envelopes
 * the shipped bridge uses was not re-measured here. An unrecognised shape yields
 * an empty list, and `sessionContradictions` then reports that as a discrepancy
 * with the profile rather than passing it off as "this vendor sent none" — a
 * parser that guessed wrong fails loudly instead of silently.
 */
function modelIds(session: SessionNew | null): string[] {
  const list = session?.models?.availableModels ?? session?.availableModels;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => (entry as { modelId?: unknown; id?: unknown } | null)?.modelId ?? (entry as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Does this failure say the ACCOUNT is refused, rather than the work?
 *
 * MEASURED twice, by two independent verifiers on two bridges: 2026-08-20 on
 * `@zed-industries/claude-code-acp` 0.69.0 and 2026-08-21 on 0.70.0, both
 * `session/prompt` answering `-32000 Authentication required` seconds after
 * `session/new` had succeeded. `session/new` does not prove a credential works;
 * for this vendor only a prompt does, and a prompt is the metered call.
 *
 * NARROW ON PURPOSE. It matches an authentication refusal and nothing else. A
 * classifier that also swallowed timeouts, rate limits or model errors would
 * stop runs for reasons this measurement does not cover, and every one of those
 * is a different remedy for the operator. Where it does not match, the previous
 * behaviour is unchanged: the item fails on its own and the run carries on.
 *
 * `OWNER-QUESTIONS.md` #14.
 */
export function isCredentialRefusal(message: string): boolean {
  return /\bauthentication required\b|\bunauthorized\b|\bnot (?:logged in|authenticated)\b/i.test(message);
}

export class Worker {
  #connection: Connection;
  #sessionId: string;
  #bytes = 0;

  // Per-turn accumulators, reset by prompt().
  #text: string[] = [];
  #toolCalls: ToolCallRecord[] = [];
  #permissions: PermissionRecord[] = [];
  #usage: Usage | undefined;
  #compaction = false;

  private constructor(
    readonly profile: LaunchProfile,
    readonly agentVersion: string,
    /** The kind this session was opened for. Ruling 49: it selects the vendor mode. */
    readonly kind: WorkKind,
    /**
     * Model ids the agent returned at `session/new`, in its own order.
     *
     * Empty on five of six profiles, and that is measured rather than missing
     * (#2). Read, never constructed: Codex encodes effort as a suffix
     * (`gpt-5.6-sol[high]`) and a constructed id is a guess wearing a
     * measurement's clothes.
     */
    readonly models: readonly string[],
    private readonly lane: Lane,
    connection: Connection,
    sessionId: string,
  ) {
    this.#connection = connection;
    this.#sessionId = sessionId;
  }


  /**
   * Spawn, handshake, open a session, and assert the lane.
   *
   * Throws if any step fails. The thrown message carries the vendor's own text
   * wherever there is one, because #25 measured that the `session/new` failure
   * names the remedy (`Gemini API key is missing…`, `Run opencode auth login…`).
   */
  static async start(profile: LaunchProfile, options: WorkerOptions): Promise<Worker> {
    const channel =
      options.channel ??
      spawnChannel(profile.command, profile.args, {
        cwd: options.cwd,
        env: buildEnvironment(profile, {
          ...(options.configRoot !== undefined ? { configRoot: options.configRoot } : {}),
          kind: options.kind ?? "write",
          restrictive: options.restrictive !== false,
        }),
      });

    // The worker is constructed after the handshake, but the connection needs
    // handlers now — so they close over a mutable slot the worker fills in.
    let self: Worker | undefined;

    const connection = new Connection(channel, {
      onRequest: (method, params) => {
        if (!self) throw new MethodNotFound(method);
        return self.#serve(method, params);
      },
      onNotification: (method, params) => {
        // Notifications can arrive before the handshake finishes; there is
        // simply nothing to record them on yet.
        if (self) self.#observe(method, params);
      },
      ...(options.onFrame ? { onFrame: options.onFrame } : {}),
    });

    try {
      // Step 1 of detection. Declaring fs capabilities is not optional: agents
      // route reads and writes back through the client when we advertise them.
      const initialize = (await connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
      })) as { agentInfo?: { name?: string; version?: string } } | null;

      // Step 2. Ruling 41 — this is where an unusable agent actually fails.
      const session = (await connection.request("session/new", {
        cwd: options.lane.root,
        mcpServers: [],
      })) as SessionNew | null;

      const sessionId = session?.sessionId;
      if (!sessionId) throw new Error(`${profile.id}: session/new returned no sessionId`);

      const version = initialize?.agentInfo?.version ?? "unknown";
      const kind = options.kind ?? "write";
      self = new Worker(profile, version, kind, modelIds(session), options.lane, connection, sessionId);

      // The Claude bridge opens in bypassPermissions; without this the lane is
      // decorative (#3).
      //
      // Failure is recorded rather than thrown here, and ruling 69 decides what
      // the caller must do with it: for a `write` item on a vendor whose profile
      // declares a lane assertion, `laneAsserted === false` BLOCKS — see
      // `laneFailureBlocks` in ./drift.ts. A vendor with no modes is not a
      // vendor in error, which is why this is not an exception.
      const assertion = profile.laneAssertion;
      const modeId = laneModeFor(assertion, kind);
      if (assertion.kind === "session-mode" && modeId && options.restrictive !== false) {
        try {
          await connection.request("session/set_mode", { sessionId, modeId });
        } catch {
          // Recorded by absence: the caller sees laneAsserted === false.
          self.#laneAsserted = false;
        }
      }

      return self;
    } catch (error) {
      const diagnostics = connection.diagnostics().trim();
      await connection.close();
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(diagnostics ? `${detail}\n--- agent stderr ---\n${diagnostics.slice(0, 1500)}` : detail);
    }
  }

  #laneAsserted = true;

  /** False when the vendor offers a restrictive mode and it could not be set. */
  get laneAsserted(): boolean {
    return this.#laneAsserted;
  }

  /**
   * Ruling 69's decision, computed rather than left to each caller.
   *
   * `laneAsserted` alone was "recorded, and the caller can decide", and a fact
   * every caller must re-derive is a fact one caller will get wrong. This is the
   * derivation, in one place: a `write` worker on a vendor that declares a lane
   * lever, whose lever did not take, has no lane — #3 measured the Claude bridge
   * opening in `bypassPermissions`, so every write there routes around the
   * client. Ruling 32's standing rule then applies: a weakened check never
   * renders as a pass.
   *
   * False for a `read-only` worker whatever happened, and that is ruling 49
   * rather than an exemption: a read-only item's directory is never diffed,
   * merged or read back, so its enforcement is brigadier's own flat `deny` and
   * needs no vendor cooperation at all.
   */
  get laneBlocks(): boolean {
    return !this.#laneAsserted && laneFailureBlocks(this.profile, this.kind);
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  /** Run one turn. Resolves even when the agent fails the task. */
  async prompt(text: string): Promise<Turn> {
    this.#text = [];
    this.#toolCalls = [];
    this.#permissions = [];
    this.#usage = undefined;
    this.#compaction = false;
    const before = this.#bytes;

    const result = (await this.#connection.request("session/prompt", {
      sessionId: this.#sessionId,
      prompt: [{ type: "text", text }],
    })) as { stopReason?: string } | null;

    return {
      stopReason: result?.stopReason ?? "unknown",
      text: this.#text.join(""),
      toolCalls: this.#toolCalls,
      permissions: this.#permissions,
      ...(this.#usage ? { usage: this.#usage } : {}),
      compactionObserved: this.#compaction,
      bytes: this.#bytes - before,
    };
  }

  /** A notification in ACP, not a request — there is nothing to await. */
  cancel(): void {
    this.#connection.notify("session/cancel", { sessionId: this.#sessionId });
  }

  async close(): Promise<void> {
    await this.#connection.close();
  }

  // ------------------------------------------------------- agent → client

  async #serve(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "session/request_permission":
        return this.#answerPermission(params as Parameters<Lane["decide"]>[0]);

      case "fs/read_text_file": {
        // Reads are judged by the same lane as writes: a worker that can read
        // outside its clone can exfiltrate the operator's tree into a prompt.
        const path = (params as { path?: string })?.path ?? "";
        if (this.lane.decide({ toolCall: { locations: [{ path }] } }).decision === "deny") {
          throw new Error(`outside lane: ${path}`);
        }
        return { content: await Bun.file(path).text() };
      }

      case "fs/write_text_file": {
        const { path = "", content = "" } = (params ?? {}) as { path?: string; content?: string };
        if (this.lane.decide({ toolCall: { locations: [{ path }] } }).decision === "deny") {
          throw new Error(`outside lane: ${path}`);
        }
        await Bun.write(path, content);
        return null;
      }

      default:
        // #6 measured that answering -32601 to everything else breaks nothing:
        // the 24 unimplemented methods were never missed.
        throw new MethodNotFound(method);
    }
  }

  #answerPermission(request: Parameters<Lane["decide"]>[0]): unknown {
    const verdict = this.lane.decide(request);
    const call = request?.toolCall;
    this.#permissions.push({
      ...(call?.kind !== undefined ? { kind: call.kind } : {}),
      ...(call?.title !== undefined ? { title: call.title } : {}),
      verdict,
    });

    const options = ((request as { options?: Array<{ optionId?: string; kind?: string }> })?.options ?? []);
    const wanted = verdict.decision === "allow" ? /allow/i : /reject|deny/i;
    const chosen = options.find((o) => wanted.test(o.kind ?? "") || wanted.test(o.optionId ?? ""));

    // No matching option is not the same as a denial, and must not be silently
    // treated as one: `cancelled` is the honest answer when the agent offered
    // us nothing we recognise.
    if (!chosen?.optionId) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: chosen.optionId } };
  }

  #observe(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const update = (params as { update?: Record<string, unknown> })?.update;
    if (!update) return;

    const kind = update["sessionUpdate"];
    this.#bytes += JSON.stringify(update).length;

    switch (kind) {
      case "agent_message_chunk": {
        const text = ((update["content"] as { text?: string } | undefined)?.text) ?? "";
        this.#text.push(text);
        // The only compaction signal Qwen gives is this sentence (#47).
        if (COMPACTION_PROSE.test(text)) this.#compaction = true;
        break;
      }
      case "tool_call":
      case "tool_call_update":
        this.#toolCalls.push({
          ...(update["toolCallId"] !== undefined ? { id: String(update["toolCallId"]) } : {}),
          ...(update["kind"] !== undefined ? { kind: String(update["kind"]) } : {}),
          ...(update["title"] !== undefined ? { title: update["title"] as string | null } : {}),
          ...(update["status"] !== undefined ? { status: String(update["status"]) } : {}),
        });
        break;
      case "usage_update": {
        const used = update["used"];
        const size = update["size"];
        if (typeof used === "number" && typeof size === "number") {
          // Validate rather than cast. Only opencode was measured to send a
          // cost object (#46), so this shape is one vendor's, and trusting an
          // unchecked cast here would put junk straight into the cost model.
          const cost = update["cost"] as { amount?: unknown; currency?: unknown } | undefined;
          const validCost =
            cost && typeof cost.amount === "number" && typeof cost.currency === "string"
              ? { amount: cost.amount, currency: cost.currency }
              : undefined;
          this.#usage = { used, size, ...(validCost ? { cost: validCost } : {}) };
        }
        break;
      }
      default:
        break;
    }
  }
}
