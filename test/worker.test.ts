// SPDX-License-Identifier: Apache-2.0
/**
 * Worker and Connection, driven through the memory channel.
 *
 * These tests exist because the real agents cost seconds and money per turn,
 * and because the cases that matter most — a vendor sending an empty permission
 * payload, an agent closing mid-request — are hard to provoke on demand and
 * trivial to script here. The memory channel is the second adapter that makes
 * the transport seam real.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryChannel } from "../src/acp/channel.ts";
import { Connection, RpcFailure, MethodNotFound, METHOD_NOT_FOUND } from "../src/acp/connection.ts";
import { Lane } from "../src/lane/lane.ts";
import { PROFILES } from "../src/agent/profiles.ts";
import { Worker } from "../src/agent/worker.ts";

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "brigadier-worker-")));

/** Parse what the client wrote, so assertions are about the wire, not internals. */
const sentFrames = (channel: { sent: string[] }) => channel.sent.map((s) => JSON.parse(s));
const frameFor = (channel: { sent: string[] }, method: string) =>
  sentFrames(channel).find((f) => f.method === method);

/**
 * Answer the handshake the way a real agent does, so `Worker.start()` completes.
 * Returns once both steps have been answered.
 */
async function completeHandshake(
  channel: ReturnType<typeof memoryChannel>,
  options: { failSession?: string; agentVersion?: string } = {},
) {
  await waitFor(() => frameFor(channel, "initialize") !== undefined);
  const initialize = frameFor(channel, "initialize");
  channel.deliver(
    JSON.stringify({
      jsonrpc: "2.0",
      id: initialize.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "fake", version: options.agentVersion ?? "1.2.3" },
        agentCapabilities: {},
      },
    }),
  );

  await waitFor(() => frameFor(channel, "session/new") !== undefined);
  const session = frameFor(channel, "session/new");
  channel.deliver(
    JSON.stringify(
      options.failSession
        ? { jsonrpc: "2.0", id: session.id, error: { code: -32000, message: options.failSession } }
        : { jsonrpc: "2.0", id: session.id, result: { sessionId: "sess-1" } },
    ),
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a frame");
    await Bun.sleep(1);
  }
}

describe("Connection", () => {
  test("correlates a response to its request", async () => {
    const channel = memoryChannel();
    const connection = new Connection(channel, {
      onRequest: async () => ({}),
      onNotification: () => {},
    });

    const pending = connection.request("ping", { a: 1 });
    await waitFor(() => channel.sent.length > 0);
    const sent = JSON.parse(channel.sent[0]!);
    channel.deliver(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { pong: true } }));

    expect(await pending).toEqual({ pong: true });
    await connection.close();
  });

  test("surfaces an error response as RpcFailure, keeping the vendor's text", async () => {
    const channel = memoryChannel();
    const connection = new Connection(channel, {
      onRequest: async () => ({}),
      onNotification: () => {},
    });

    const pending = connection.request("session/new", {});
    await waitFor(() => channel.sent.length > 0);
    const sent = JSON.parse(channel.sent[0]!);
    channel.deliver(
      JSON.stringify({
        jsonrpc: "2.0",
        id: sent.id,
        error: { code: -32000, message: "Gemini API key is missing or not configured." },
      }),
    );

    await expect(pending).rejects.toThrow(/Gemini API key is missing/);
    await pending.catch((e) => {
      expect(e).toBeInstanceOf(RpcFailure);
      expect((e as RpcFailure).rpc.code).toBe(-32000);
    });
    await connection.close();
  });

  test("answers an unknown agent→client request with -32601 rather than hanging", async () => {
    const channel = memoryChannel();
    const connection = new Connection(channel, {
      onRequest: async (method) => {
        throw new MethodNotFound(method);
      },
      onNotification: () => {},
    });

    channel.deliver(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/exotic", params: {} }));
    await waitFor(() => channel.sent.some((s) => JSON.parse(s).id === 99));

    const reply = sentFrames(channel).find((f) => f.id === 99);
    expect(reply.error.code).toBe(METHOD_NOT_FOUND);
    await connection.close();
  });

  test("rejects in-flight requests when the agent closes — not a hang", async () => {
    const channel = memoryChannel();
    const connection = new Connection(channel, {
      onRequest: async () => ({}),
      onNotification: () => {},
    });

    const pending = connection.request("session/prompt", {});
    await waitFor(() => channel.sent.length > 0);
    channel.finish();

    await expect(pending).rejects.toThrow(/closed/);
    await connection.close();
  });
});

describe("Worker.start — two-step detection (ruling 41)", () => {
  test("resolves only when BOTH steps succeed", async () => {
    const dir = scratch();
    const channel = memoryChannel();
    const starting = Worker.start(PROFILES.copilot, {
      cwd: dir,
      lane: new Lane(dir),
      channel,
    });

    await completeHandshake(channel, { agentVersion: "1.0.80" });
    const worker = await starting;

    expect(worker.agentVersion).toBe("1.0.80");
    expect(worker.sessionId).toBe("sess-1");
    // session/new must carry an absolute cwd — it is required by the protocol.
    expect(frameFor(channel, "session/new").params.cwd).toBe(dir);

    await worker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // The control: a handshake alone must NOT count as detected.
  test("rejects when the handshake succeeds but the session fails", async () => {
    const dir = scratch();
    const channel = memoryChannel();
    const starting = Worker.start(PROFILES.gemini, {
      cwd: dir,
      lane: new Lane(dir),
      channel,
    });

    await completeHandshake(channel, {
      failSession: "This client is no longer supported for Gemini Code Assist for individuals",
    });

    await expect(starting).rejects.toThrow(/no longer supported/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("asserts the restrictive session mode where the vendor has one", async () => {
    const dir = scratch();
    const channel = memoryChannel();
    const starting = Worker.start(PROFILES.claude, { cwd: dir, lane: new Lane(dir), channel });

    await completeHandshake(channel);
    await waitFor(() => frameFor(channel, "session/set_mode") !== undefined);
    const setMode = frameFor(channel, "session/set_mode");
    // Claude's bridge opens in bypassPermissions; without this the lane is decorative.
    expect(setMode.params.modeId).toBe("default");
    channel.deliver(JSON.stringify({ jsonrpc: "2.0", id: setMode.id, result: {} }));

    const worker = await starting;
    expect(worker.laneAsserted).toBe(true);
    await worker.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Worker.prompt", () => {
  async function startWorker(dir: string, channel: ReturnType<typeof memoryChannel>) {
    const starting = Worker.start(PROFILES.copilot, { cwd: dir, lane: new Lane(dir), channel });
    await completeHandshake(channel);
    return starting;
  }

  test("denies a Codex-shaped empty permission payload during a real turn", async () => {
    const dir = scratch();
    const channel = memoryChannel();
    const worker = await startWorker(dir, channel);

    const turn = worker.prompt("write a file");
    await waitFor(() => frameFor(channel, "session/prompt") !== undefined);
    const prompt = frameFor(channel, "session/prompt");

    // Exactly what Codex 1.4.0 sends: no title, no locations, no rawInput.
    channel.deliver(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "session/request_permission",
        params: {
          sessionId: "sess-1",
          toolCall: { toolCallId: "c1", kind: "edit", title: null, locations: [] },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Deny", kind: "reject_once" },
          ],
        },
      }),
    );

    await waitFor(() => sentFrames(channel).some((f) => f.id === 7));
    const answer = sentFrames(channel).find((f) => f.id === 7);
    expect(answer.result.outcome.optionId).toBe("reject");

    channel.deliver(JSON.stringify({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } }));
    const result = await turn;

    expect(result.permissions).toHaveLength(1);
    expect(result.permissions[0]!.verdict.reason).toBe("unplaceable");
    await worker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("captures usage_update, including opencode's cost object", async () => {
    const dir = scratch();
    const channel = memoryChannel();
    const worker = await startWorker(dir, channel);

    const turn = worker.prompt("hi");
    await waitFor(() => frameFor(channel, "session/prompt") !== undefined);
    const prompt = frameFor(channel, "session/prompt");

    channel.deliver(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: { sessionUpdate: "usage_update", used: 24199, size: 200000, cost: { amount: 0, currency: "USD" } },
        },
      }),
    );
    channel.deliver(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } },
      }),
    );
    channel.deliver(JSON.stringify({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } }));

    const result = await turn;
    expect(result.usage).toEqual({ used: 24199, size: 200000, cost: { amount: 0, currency: "USD" } });
    expect(result.text).toBe("done");
    expect(result.bytes).toBeGreaterThan(0);
    await worker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("detects Qwen's prose-only compaction announcement", async () => {
    const dir = scratch();
    const channel = memoryChannel();
    const worker = await startWorker(dir, channel);

    const turn = worker.prompt("hi");
    await waitFor(() => frameFor(channel, "session/prompt") !== undefined);
    const prompt = frameFor(channel, "session/prompt");

    channel.deliver(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              text: "IMPORTANT: This conversation approached the input token limit for qwen3.6-plus. A compressed context will be sent for future messages (compressed from: 44791 to 38106 tokens).",
            },
          },
        },
      }),
    );
    channel.deliver(JSON.stringify({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } }));

    const result = await turn;
    expect(result.compactionObserved).toBe(true);
    await worker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // The control for the test above: ordinary prose must not read as compaction.
  test("does not mistake ordinary text for compaction", async () => {
    const dir = scratch();
    const channel = memoryChannel();
    const worker = await startWorker(dir, channel);

    const turn = worker.prompt("hi");
    await waitFor(() => frameFor(channel, "session/prompt") !== undefined);
    const prompt = frameFor(channel, "session/prompt");

    channel.deliver(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: { sessionUpdate: "agent_message_chunk", content: { text: "I compressed the image and summarised the file." } },
        },
      }),
    );
    channel.deliver(JSON.stringify({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } }));

    const result = await turn;
    expect(result.compactionObserved).toBe(false);
    await worker.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
