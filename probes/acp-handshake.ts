/**
 * Minimal ACP client probe — ticket #14, step 1.
 *
 * Spawns an agent as a subprocess, speaks newline-delimited JSON-RPC 2.0 on its
 * stdio, sends `initialize`, and prints whatever comes back. Nothing else.
 *
 * Deliberately bounded: the process is killed after a fixed deadline whether or
 * not it answered, because v1 recorded that agent CLIs do not reliably exit and
 * an unbounded probe turns into a hang with no attribution.
 *
 * Usage: bun acp-probe.ts <deadline-ms> <command> [args...]
 */

const [deadlineRaw, command, ...args] = Bun.argv.slice(2);
const deadline = Number(deadlineRaw);
if (!command || !Number.isFinite(deadline)) {
  console.error("usage: bun acp-probe.ts <deadline-ms> <command> [args...]");
  process.exit(2);
}

const started = Date.now();
const stamp = () => `${String(Date.now() - started).padStart(6)}ms`;

const child = Bun.spawn([command, ...args], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, NO_COLOR: "1" },
});

// Collect stderr separately — a bridge that fails to start usually says why there.
const stderrChunks: string[] = [];
(async () => {
  const decoder = new TextDecoder();
  for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
    stderrChunks.push(decoder.decode(chunk));
  }
})().catch(() => {});

const send = (message: unknown) => {
  const line = `${JSON.stringify(message)}\n`;
  child.stdin.write(line);
  child.stdin.flush();
  console.log(`${stamp()}  --> ${line.trimEnd()}`);
};

// ACP is newline-delimited JSON-RPC 2.0 over stdio.
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
    },
  },
});

const timer = setTimeout(() => {
  console.log(`${stamp()}  !! deadline reached, killing`);
  child.kill("SIGKILL");
}, deadline);

let sawAnyLine = false;
const decoder = new TextDecoder();
let buffered = "";
try {
  for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true });
    let index = buffered.indexOf("\n");
    while (index !== -1) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (line.length > 0) {
        sawAnyLine = true;
        console.log(`${stamp()}  <-- ${line}`);
        // One answered request is all this probe is for.
        try {
          const parsed = JSON.parse(line);
          if (parsed?.id === 1) {
            clearTimeout(timer);
            child.kill("SIGKILL");
          }
        } catch {
          // A non-JSON line is itself a finding; keep reading.
        }
      }
      index = buffered.indexOf("\n");
    }
  }
} catch {
  // Stream torn down by the kill; that is the normal exit path here.
}

clearTimeout(timer);
const exitCode = await child.exited;
const stderrText = stderrChunks.join("").trim();
console.log(`${stamp()}  == exit ${exitCode}, stdout lines seen: ${sawAnyLine}`);
if (stderrText.length > 0) {
  console.log(`--- stderr ---\n${stderrText.slice(0, 4000)}`);
}
