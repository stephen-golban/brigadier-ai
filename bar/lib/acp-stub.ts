// SPDX-License-Identifier: Apache-2.0
/**
 * A fake ACP agent, so item 1 can be driven without a credentialed machine.
 *
 * This is the harness's ground truth. Ruling 41 made detection two steps — a
 * handshake proves an agent is PRESENT, a session proves it is USABLE — and the
 * only way to check that the product reports those two states honestly is to own
 * an agent that is definitely in one of them. A real vendor cannot be asked to
 * be logged out on demand, and an item that waited for one would be a
 * `SKIPPED`.
 *
 * It speaks exactly as much of the protocol as detection uses: newline-delimited
 * JSON-RPC 2.0 on stdin/stdout, `initialize`, `session/new`, `session/set_mode`,
 * and `-32601` for everything else. Nothing here is imported from `src/` — the
 * wire format was read off the protocol, and if the product's framing ever
 * diverges from this, that divergence is a finding rather than a maintenance
 * chore.
 *
 * **It never asks the client anything, and that is load-bearing.** The deadlock
 * fixed in `bar/fakes/vendor.ts` on 2026-08-18 was a handler awaiting its own
 * `session/request_permission` inside the body of the read loop, so the reply —
 * which arrives on the stdin that loop had stopped reading — could never be
 * seen. This stub is a pure responder: every case below is a synchronous `send`
 * and nothing in it awaits a byte. If a future edit gives it an outbound
 * request, the handling must move off this loop the way the vendor's did.
 *
 * `protocolVersion: 1` is answered unconditionally and that is deliberate:
 * MEASURED against copilot 1.0.80, qwen-code 0.21.13, OpenCode 1.18.18 and
 * gemini-cli 0.55.1 on 2026-08-17, **all four returned `protocolVersion: 1`**,
 * so the field discriminates nothing and a stub that varied it would be
 * modelling a world that was not measured.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exitWhenOrphaned } from "./orphan.ts";

export interface StubConfig {
  /** Reported as `agentInfo.version` at `initialize`. */
  version: string;
  /** Reported as `agentInfo.name`. */
  name: string;
  /**
   * Where to record proof of contact, one file per protocol step.
   *
   * This is what makes item 1 an assertion about what the binary DID rather than
   * about what it printed. A product that reports an agent `usable` without ever
   * spawning it leaves this directory empty, and no amount of correct-looking
   * JSON on stdout can put the files there.
   */
  contactDir?: string;
  /** When set, `session/new` answers with this message — the "logged out" shape. */
  sessionError?: string;
  /** When set, `initialize` itself fails: the agent is present but unreachable. */
  initializeError?: string;
  /** Exit before reading a single byte — a command on `PATH` that is not an agent. */
  exitImmediately?: boolean;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function main(configPath: string): Promise<void> {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as StubConfig;

  /** Proof of contact: bytes only a process that really ran can leave. */
  const contact = (step: string): void => {
    if (config.contactDir === undefined) return;
    try {
      mkdirSync(config.contactDir, { recursive: true });
      writeFileSync(join(config.contactDir, step), `pid ${process.pid} at ${Date.now()}\n`);
    } catch {
      // A stub that cannot record contact must not take the agent down with it.
    }
  };

  contact("spawned");
  if (config.exitImmediately === true) process.exit(7);
  // The same orphan guard the vendor fixture carries, for the same reason: this
  // is a process the product spawns and may not live to reap.
  exitWhenOrphaned("acp-stub");

  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk as Uint8Array);
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.trim() === "") continue;

      let message: { id?: number; method?: string };
      try {
        message = JSON.parse(line) as { id?: number; method?: string };
      } catch {
        continue;
      }
      const { id, method } = message;
      if (id === undefined || method === undefined) continue;

      switch (method) {
        case "initialize":
          contact("initialize");
          if (config.initializeError !== undefined) {
            send({ jsonrpc: "2.0", id, error: { code: -32000, message: config.initializeError } });
          } else {
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: 1,
                agentInfo: { name: config.name, version: config.version },
                agentCapabilities: {},
              },
            });
          }
          break;

        case "session/new":
          contact("session-new");
          if (config.sessionError !== undefined) {
            send({ jsonrpc: "2.0", id, error: { code: -32000, message: config.sessionError } });
          } else {
            send({ jsonrpc: "2.0", id, result: { sessionId: "bar-stub-session" } });
          }
          break;

        case "session/set_mode":
          send({ jsonrpc: "2.0", id, result: null });
          break;

        default:
          send({ jsonrpc: "2.0", id, error: { code: -32601, message: `not implemented: ${method}` } });
      }
    }
  }
}

if (import.meta.main) {
  const configPath = Bun.argv[2];
  if (configPath === undefined) {
    process.stderr.write("acp-stub: a config path is required\n");
    process.exit(2);
  }
  await main(configPath);
}
