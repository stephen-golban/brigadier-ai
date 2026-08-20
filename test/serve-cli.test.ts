// SPDX-License-Identifier: Apache-2.0
/**
 * `brigadier serve` at the PROCESS boundary, because two of its three claims are
 * invisible to a unit test.
 *
 * `test/serve.test.ts` drives the server over `memoryChannel` and proves the
 * protocol. It cannot prove either of these:
 *
 *   - RULING 65. Every frame goes through the process's ONE `Sink`. In-memory
 *     the writer is a test's array; only a spawned binary shows what actually
 *     lands on the real file descriptor, and the assertion is that EVERY line on
 *     stdout parses as JSON. A second writer — a stray `console.log`, a warning,
 *     a banner — is a non-JSON line, so that one assertion is the whole
 *     one-sink claim in the form a client would experience it.
 *   - RULING 57. `serve` is in `ORCHESTRATING`, so inside a worker it must
 *     refuse with exit 3 before it reads a byte of stdin. A set membership is a
 *     unit test; the refusal happening BEFORE dispatch, and the ledger entry
 *     ruling 59 asks for, are not.
 *
 * MACHINE DISCIPLINE. One process at a time, every wait bounded, and every
 * spawn killed on the way out whatever the assertions did. `stdin` is closed
 * immediately after the frames, which is what makes the server exit on its own
 * rather than needing to be killed — but the kill is there anyway, because a
 * server test that hangs poisons the round for every other builder.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REFUSAL, WORKER_MARKER } from "../src/agent/marker.ts";
import { NOTHING_WAS_STARTED, PROTOCOL_VERSION } from "../src/serve/index.ts";
import { RUN_ROOT_ENV, refusalLedgerPath } from "../src/queue/index.ts";
import { RUN_DIR } from "../src/repo/layout.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Outside every temp region (ruling 61) and outside the operator's real
// dotfiles, the same placement `test/cli-interrupt.test.ts` uses.
const SCRATCH = mkdtempSync(join(homedir(), ".brigadier-serve-test-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface Ran {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the CLI, write the frames, close stdin, and reap it.
 *
 * The timeout races the exit and KILLS rather than resolving, so nothing here
 * can outlive the test file.
 */
async function serve(frames: unknown[], env: Record<string, string>, ms = 30_000): Promise<Ran> {
  const child = Bun.spawn(["bun", CLI, "serve", "--repo", ROOT], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    for (const frame of frames) child.stdin.write(`${JSON.stringify(frame)}\n`);
    await child.stdin.end();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    });
    const finished = await Promise.race([child.exited, timeout]);
    if (timer !== null) clearTimeout(timer);
    if (finished === "timeout") {
      child.kill("SIGKILL");
      await child.exited;
      throw new Error(`brigadier serve did not exit within ${ms} ms`);
    }
    return {
      code: child.exitCode,
      signal: child.signalCode,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    };
  } finally {
    // Belt and braces: reaped above on every path, killed here if an assertion
    // above threw between the spawn and the wait.
    child.kill("SIGKILL");
  }
}

const HANDSHAKE = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION } },
  { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: ROOT } },
];

function parsedLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the real binary speaks ACP on stdio and exits when the client hangs up", () => {
  test("a handshake and a prompt come back as frames, and stdout is NOTHING but frames", async () => {
    const ran = await serve(
      [
        ...HANDSHAKE,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: { sessionId: "brigadier-1", prompt: [{ type: "text", text: "--plan /no/such/plan.json" }] },
        },
      ],
      { [RUN_ROOT_ENV]: SCRATCH },
    );

    expect(ran.signal).toBeNull();
    expect(ran.code).toBe(0);

    // RULING 65, in the form a client experiences it: one writer on stdout, so
    // every line is a frame. A stray `console.log` anywhere on this path is a
    // line that does not parse, and this throws on it.
    const frames = parsedLines(ran.stdout);
    expect(frames.length).toBeGreaterThan(3);
    for (const frame of frames) expect(frame["jsonrpc"]).toBe("2.0");

    const initialize = frames.find((f) => f["id"] === 1);
    expect((initialize?.["result"] as { protocolVersion?: number })?.["protocolVersion"]).toBe(PROTOCOL_VERSION);
    const created = frames.find((f) => f["id"] === 2);
    expect((created?.["result"] as { sessionId?: string })?.["sessionId"]).toBe("brigadier-1");

    const turn = frames.find((f) => f["id"] === 3);
    expect((turn?.["result"] as { stopReason?: string })?.["stopReason"]).toBe("end_turn");

    // The turn did the work and said what it did not do.
    const prose = frames
      .filter((f) => f["method"] === "session/update")
      .map((f) => (f["params"] as { update?: Record<string, unknown> })?.update)
      .filter((u): u is Record<string, unknown> => u?.["sessionUpdate"] === "agent_message_chunk")
      .map((u) => ((u["content"] as { text?: string })?.text ?? ""))
      .join("");
    expect(prose).toContain("/no/such/plan.json");
    expect(prose).toContain("nothing was started");

    // And nothing was: ruling 53's outside-checkable property.
    expect(existsSync(join(SCRATCH, RUN_DIR))).toBe(false);
  }, 60_000);

  /**
   * The blind critic's reproduction, on the real binary.
   *
   * `{"version":1,"items":[null]}` is a plan an operator can write, and
   * `validatePlan` throws reading `entry.id`. Before the repair the wire carried
   * `admission failed: null is not an object (evaluating 'entry.id')` and then
   * `{"stopReason":"end_turn"}` with no statement that nothing had run —
   * `grep -c "nothing was started"` was 0 for that turn and 1 for every other.
   * An editor renders that as a completed turn.
   */
  test("a plan that makes admission THROW still says nothing was started", async () => {
    const plan = join(SCRATCH, "null-item.json");
    writeFileSync(plan, JSON.stringify({ version: 1, items: [null] }));
    const ran = await serve(
      [
        ...HANDSHAKE,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: { sessionId: "brigadier-1", prompt: [{ type: "text", text: `--plan ${plan}` }] },
        },
      ],
      { [RUN_ROOT_ENV]: SCRATCH },
    );

    expect(ran.code).toBe(0);
    const frames = parsedLines(ran.stdout);
    expect((frames.find((f) => f["id"] === 3)?.["result"] as { stopReason?: string })?.["stopReason"]).toBe("end_turn");
    const prose = frames
      .filter((f) => f["method"] === "session/update")
      .map((f) => (f["params"] as { update?: Record<string, unknown> })?.update)
      .filter((u): u is Record<string, unknown> => u?.["sessionUpdate"] === "agent_message_chunk")
      .map((u) => ((u["content"] as { text?: string })?.text ?? ""))
      .join("");
    expect(prose).toContain("admission failed:");
    expect(prose).toContain("entry.id");
    // The whole of the defect, in one assertion on the bytes the client sees.
    expect(prose.split(NOTHING_WAS_STARTED)).toHaveLength(2);
    expect(prose.trimEnd().endsWith(NOTHING_WAS_STARTED)).toBe(true);
    expect(existsSync(join(SCRATCH, RUN_DIR))).toBe(false);
  }, 60_000);

  test("an unimplemented method is -32601 from the real binary too", async () => {
    const ran = await serve(
      [...HANDSHAKE, { jsonrpc: "2.0", id: 3, method: "session/set_mode", params: {} }],
      { [RUN_ROOT_ENV]: SCRATCH },
    );
    expect(ran.code).toBe(0);
    const answer = parsedLines(ran.stdout).find((f) => f["id"] === 3);
    expect((answer?.["error"] as { code?: number })?.["code"]).toBe(-32601);
    expect(answer?.["result"]).toBeUndefined();
  }, 60_000);
});

describe("ruling 57: `serve` orchestrates, so a worker may not start one", () => {
  /**
   * A server started inside a worker has handed a driving surface for brigadier
   * to whatever holds the other end of its stdio. That is finding 114 with an
   * extra hop, and a hop is not a mitigation — which is why `serve` is in
   * `ORCHESTRATING` even though this build's `session/prompt` stops at
   * admission.
   */
  test("exit 3, the refusal on stderr, no frame on stdout, and ruling 59's ledger entry", async () => {
    const runRoot = mkdtempSync(join(SCRATCH, "refused-"));
    const ran = await serve([...HANDSHAKE], {
      [WORKER_MARKER]: "run-abc/2",
      [RUN_ROOT_ENV]: runRoot,
    });

    expect(ran.code).toBe(3);
    expect(ran.stderr).toContain(REFUSAL);
    // Refused BEFORE dispatch: not one frame was written, so the handshake it
    // was sent was never answered.
    expect(ran.stdout.trim()).toBe("");

    // From the product's own function rather than a transcribed path: RUN_DIR is
    // "r", and a hand-written "runs" here would have made this assert nothing.
    const ledger = refusalLedgerPath(runRoot, "run-abc");
    expect(existsSync(ledger)).toBe(true);
    const entry = JSON.parse(readFileSync(ledger, "utf8").trim().split("\n").at(-1)!) as Record<string, unknown>;
    expect(entry["command"]).toBe("serve");
    expect(entry["runId"]).toBe("run-abc");
    expect(entry["item"]).toBe(2);
  }, 60_000);

  /**
   * NEGATIVE CONTROL. The same command, the same frames, the same scratch run
   * root — and no worker marker. It must NOT exit 3 and it must answer the
   * handshake. Without this, a `serve` that was broken outright, or a guard that
   * refused unconditionally, would look identical to a working refusal.
   */
  test("and the identical invocation WITHOUT the marker is served", async () => {
    const ran = await serve([...HANDSHAKE], { [RUN_ROOT_ENV]: SCRATCH, [WORKER_MARKER]: "" });
    expect(ran.code).toBe(0);
    expect(ran.stderr).not.toContain(REFUSAL);
    const initialize = parsedLines(ran.stdout).find((f) => f["id"] === 1);
    expect((initialize?.["result"] as { protocolVersion?: number })?.["protocolVersion"]).toBe(PROTOCOL_VERSION);
  }, 60_000);
});
