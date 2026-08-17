/**
 * Probe helper — ticket #48. Sits between a real ACP client and our agent shim
 * and records every frame in both directions.
 *
 * #6 established that a four-method agent is enough — but it was verified
 * against a client written for the probe, which is not evidence about Zed,
 * JetBrains or the VS Code extension. Capability negotiation is exactly where
 * clients differ, so the question is what a REAL client actually calls.
 *
 * The shim answers `-32601` to everything it does not implement, so this log
 * answers #48's questions directly: which of the 28 methods does the client
 * require, does it tolerate a multi-minute turn, does it call `session/load` or
 * `authenticate`, and does it consume `usage_update`.
 *
 * Transparent: stdin and stdout are forwarded byte-for-byte, so the client and
 * the agent behave exactly as they would without it.
 *
 * Usage: bun acp-tee.ts <logfile> -- <agent command> [args...]
 */

import { appendFileSync, writeFileSync } from "node:fs";

const argv = Bun.argv.slice(2);
const dd = argv.indexOf("--");
if (dd === -1) {
  console.error("usage: bun acp-tee.ts <logfile> -- <command> [args...]");
  process.exit(2);
}
const logPath = argv[0];
const [command, ...args] = argv.slice(dd + 1);

const started = Date.now();
writeFileSync(logPath, `# acp-tee ${new Date().toISOString()} cmd=${[command, ...args].join(" ")}\n`);
const log = (dir: "client->agent" | "agent->client", line: string) => {
  appendFileSync(logPath, `${JSON.stringify({ at: Date.now() - started, dir, raw: line })}\n`);
};

const child = Bun.spawn([command, ...args], {
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
  env: { ...process.env, NO_COLOR: "1" },
});

// Agent stderr is kept, because a client that rejects our agent often explains
// itself there and nowhere else.
(async () => {
  const dec = new TextDecoder();
  for await (const c of child.stderr as ReadableStream<Uint8Array>) {
    appendFileSync(logPath, `${JSON.stringify({ at: Date.now() - started, dir: "agent-stderr", raw: dec.decode(c) })}\n`);
  }
})().catch(() => {});

// Split on newlines for the log, but forward the ORIGINAL bytes, so nothing
// depends on this process's framing being identical to the agent's.
const relay = async (
  src: ReadableStream<Uint8Array>,
  sink: (b: Uint8Array) => void,
  dir: "client->agent" | "agent->client",
) => {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of src) {
    sink(chunk);
    buf += dec.decode(chunk, { stream: true });
    let i = buf.indexOf("\n");
    while (i !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      if (line) log(dir, line);
    }
  }
};

const toAgent = relay(
  Bun.stdin.stream() as ReadableStream<Uint8Array>,
  (b) => { child.stdin.write(b); child.stdin.flush(); },
  "client->agent",
);
const toClient = relay(
  child.stdout as ReadableStream<Uint8Array>,
  // process.stdout.write, NOT Bun.write(Bun.stdout, …): the latter buffers, and
  // against a long-lived client the agent's first response never reaches the
  // pipe — the client sits waiting through its whole deadline while the tee
  // looks perfectly healthy. Standalone it works, because exit flushes.
  (b) => { process.stdout.write(b); },
  "agent->client",
);

await Promise.race([toAgent, toClient]);
await child.exited.catch(() => {});
appendFileSync(logPath, `# exit ${Date.now() - started}ms\n`);
