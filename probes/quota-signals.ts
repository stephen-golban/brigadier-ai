/**
 * Probe — ticket #15. Is there a quota signal outside ACP, and does it survive
 * the bridge?
 *
 * Two halves:
 *   codex   `codex app-server` speaks JSON-RPC on stdio and answers
 *           `account/rateLimits/read`. The server exits on stdin EOF, so the
 *           pipe is held open until we are done.
 *   claude  the bridge drives `claude --output-format stream-json`, which emits
 *           a free `rate_limit_event` per turn. That half is measured by teeing
 *           the stream through a CLAUDE_CODE_EXECUTABLE shim — see the ticket.
 *
 * Usage: bun quota-signals.ts <deadline-ms> <command> [args...]
 */

const [deadlineRaw, command, ...args] = Bun.argv.slice(2);
const deadline = Number(deadlineRaw);
if (!command || !Number.isFinite(deadline)) {
  console.error("usage: bun quota-signals.ts <deadline-ms> <command> [args...]");
  process.exit(2);
}

const started = Date.now();
const stamp = () => `${String(Date.now() - started).padStart(6)}ms`;

const child = Bun.spawn([command, ...args], {
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
  env: { ...process.env, NO_COLOR: "1" },
});

const stderrChunks: string[] = [];
(async () => {
  const dec = new TextDecoder();
  for await (const c of child.stderr as ReadableStream<Uint8Array>) stderrChunks.push(dec.decode(c));
})().catch(() => {});

const send = (m: unknown) => {
  child.stdin.write(`${JSON.stringify(m)}\n`);
  child.stdin.flush();
  console.log(`${stamp()}  --> ${JSON.stringify(m)}`);
};

send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { clientInfo: { name: "brigadier-probe", title: "brigadier probe", version: "0.0.0" } },
});

const timer = setTimeout(() => { console.log(`${stamp()}  !! deadline`); child.kill("SIGKILL"); }, deadline);

let asked = false;
const answered = new Set<number>();
const dec = new TextDecoder();
let buf = "";
try {
  for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i = buf.indexOf("\n");
    while (i !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      if (!line) continue;
      console.log(`${stamp()}  <-- ${line.slice(0, 2000)}`);
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === 1 && !asked) {
        asked = true;
        // The app-server wants the `initialized` notification before it will
        // serve requests, exactly as LSP does.
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });
        send({ jsonrpc: "2.0", id: 3, method: "account/usage/read", params: {} });
      }
      // Wait for BOTH answers — killing on the first one back drops the other,
      // and the two do not arrive in the order they were sent.
      if (msg.id === 2 || msg.id === 3) {
        answered.add(msg.id);
        if (answered.has(2) && answered.has(3)) { clearTimeout(timer); child.kill("SIGKILL"); }
      }
    }
  }
} catch { /* torn down by the kill */ }

clearTimeout(timer);
const code = await child.exited;
console.log(`${stamp()}  == exit ${code}`);
const err = stderrChunks.join("").trim();
if (err) console.log(`--- stderr ---\n${err.slice(0, 2000)}`);
