/**
 * Probe — tickets #14 (prototype), #3 (does the permission model enforce a
 * lane?) and #2 (what does `session/new` report that `initialize` did not?).
 *
 * A real ACP client: spawns an agent, handshakes, opens a session with a
 * `git clone --local` as `cwd`, runs one prompt turn, and answers every
 * `session/request_permission` itself. The lane is enforced *here*, in the
 * client, which is the property locked decision 2 buys and the thing this
 * probe exists to test rather than believe.
 *
 * Everything the agent sends is written to a transcript file, because the token
 * volume of a turn is itself one of the measurements.
 *
 * Usage:
 *   bun acp-session.ts --cwd <dir> --out <dir> [--policy allow|deny|lane]
 *                      [--prompt <text>] [--model <id>] [--deadline <ms>]
 *                      -- <command> [args...]
 *
 * Policies:
 *   allow  approve everything (baseline: what does the agent even ask for?)
 *   deny   refuse everything (does refusal actually stop the write?)
 *   lane   approve writes inside <cwd>, refuse everything else
 */

import { mkdirSync, writeFileSync, appendFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";

// ------------------------------------------------------------------ arguments
const argv = Bun.argv.slice(2);
const dashdash = argv.indexOf("--");
if (dashdash === -1) {
  console.error("usage: bun acp-session.ts [flags] -- <command> [args...]");
  process.exit(2);
}
const flags = argv.slice(0, dashdash);
const [command, ...commandArgs] = argv.slice(dashdash + 1);
const flag = (name: string, fallback = "") => {
  const i = flags.indexOf(`--${name}`);
  return i === -1 ? fallback : (flags[i + 1] ?? "");
};

const cwd = resolve(flag("cwd", process.cwd()));
const outDir = resolve(flag("out", join(cwd, "..", "probe-out")));
const policy = flag("policy", "lane");
const promptText = flag("prompt", "Create a file called hello.txt containing the single word hello.");
const modelId = flag("model", "");
const modeId = flag("mode", "");
const deadline = Number(flag("deadline", "300000"));

mkdirSync(outDir, { recursive: true });
const transcriptPath = join(outDir, "transcript.jsonl");
const notesPath = join(outDir, "notes.log");
writeFileSync(transcriptPath, "");
writeFileSync(notesPath, "");

const started = Date.now();
const stamp = () => `${String(Date.now() - started).padStart(7)}ms`;
const note = (line: string) => {
  const text = `${stamp()}  ${line}`;
  console.log(text);
  appendFileSync(notesPath, `${text}\n`);
};

// The lane. `realpath` first, because v1 shipped a containment escape where
// `resolve()` collapsed `..` lexically and the symlink was never seen.
const laneRoot = realpathSync(cwd);
const insideLane = (candidate: string): boolean => {
  if (!candidate) return false;
  const abs = isAbsolute(candidate) ? candidate : join(laneRoot, candidate);
  // realpath the deepest existing ancestor, so a path that does not exist yet
  // is still judged on where it would actually land.
  let probe = abs;
  const unresolved: string[] = [];
  while (!existsSync(probe)) {
    const parent = resolve(probe, "..");
    if (parent === probe) break;
    unresolved.unshift(probe.slice(parent.length + 1));
    probe = parent;
  }
  let real: string;
  try { real = realpathSync(probe); } catch { return false; }
  const full = unresolved.length ? join(real, ...unresolved) : real;
  return full === laneRoot || full.startsWith(laneRoot + "/") || full.startsWith(laneRoot + "\\");
};

// ------------------------------------------------------------------- transport
const child = Bun.spawn([command, ...commandArgs], {
  cwd,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, NO_COLOR: "1" },
});

const stderrChunks: string[] = [];
(async () => {
  const dec = new TextDecoder();
  for await (const c of child.stderr as ReadableStream<Uint8Array>) stderrChunks.push(dec.decode(c));
})().catch(() => {});

let nextId = 1;
const pending = new Map<number, (value: any) => void>();

const write = (message: unknown) => {
  appendFileSync(transcriptPath, `${JSON.stringify({ dir: "out", at: Date.now() - started, message })}\n`);
  child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.flush();
};

const request = (method: string, params: unknown): Promise<any> => {
  const id = nextId++;
  return new Promise((resolveOne, rejectOne) => {
    pending.set(id, (response) => {
      if (response.error) rejectOne(new Error(`${method}: ${JSON.stringify(response.error)}`));
      else resolveOne(response.result);
    });
    write({ jsonrpc: "2.0", id, method, params });
  });
};

// What the agent asked us for, and what we said. This is the evidence for #3.
const permissionLog: Array<Record<string, unknown>> = [];
const toolCalls: Array<Record<string, unknown>> = [];
let updateCount = 0;
let transcriptChars = 0;

// -------------------------------------------------- server side of the client
const handleAgentRequest = async (msg: any) => {
  const { id, method, params } = msg;
  const reply = (result: unknown) => write({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => write({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "session/request_permission": {
      // Work out what is actually being asked for. ACP puts the tool call in
      // `toolCall`; the locations are the only structured path information.
      const call = params?.toolCall ?? {};
      const locations: string[] = (call.locations ?? []).map((l: any) => l.path).filter(Boolean);
      const options: any[] = params?.options ?? [];
      const allowOpt = options.find((o) => /allow/i.test(o.kind ?? "") || /allow/i.test(o.optionId ?? ""));
      const denyOpt = options.find((o) => /reject|deny/i.test(o.kind ?? "") || /reject|deny/i.test(o.optionId ?? ""));

      let decision: "allow" | "deny";
      if (policy === "allow") decision = "allow";
      else if (policy === "deny") decision = "deny";
      else {
        // Refuse anything we cannot place. An unlocatable write is exactly the
        // case a lane must not wave through.
        decision = locations.length > 0 && locations.every(insideLane) ? "allow" : "deny";
      }

      const record = {
        at: Date.now() - started,
        title: call.title,
        kind: call.kind,
        rawInput: call.rawInput,
        locations,
        options: options.map((o) => ({ id: o.optionId, kind: o.kind, name: o.name })),
        decision,
      };
      permissionLog.push(record);
      note(`PERM  ${decision.toUpperCase().padEnd(5)} kind=${call.kind ?? "?"} locations=${JSON.stringify(locations)} title=${JSON.stringify(call.title ?? "")}`);

      const chosen = decision === "allow" ? allowOpt : denyOpt;
      if (!chosen) {
        note(`PERM  !! no option matched decision=${decision}; options=${JSON.stringify(record.options)}`);
        reply({ outcome: { outcome: "cancelled" } });
      } else {
        reply({ outcome: { outcome: "selected", optionId: chosen.optionId } });
      }
      return;
    }
    case "fs/read_text_file": {
      const path = params?.path;
      if (!insideLane(path)) { note(`FS    DENY read outside lane: ${path}`); return fail(-32001, "outside lane"); }
      try { reply({ content: await Bun.file(path).text() }); }
      catch (e: any) { fail(-32002, String(e.message)); }
      return;
    }
    case "fs/write_text_file": {
      const path = params?.path;
      if (!insideLane(path)) { note(`FS    DENY write outside lane: ${path}`); return fail(-32001, "outside lane"); }
      await Bun.write(path, params?.content ?? "");
      note(`FS    ALLOW write ${path}`);
      reply(null);
      return;
    }
    default:
      note(`REQ   unhandled agent request: ${method}`);
      fail(-32601, `unhandled: ${method}`);
  }
};

const handleNotification = (msg: any) => {
  if (msg.method !== "session/update") { note(`NOTE  ${msg.method}`); return; }
  updateCount++;
  const u = msg.params?.update ?? {};
  const kind = u.sessionUpdate;
  if (kind === "tool_call" || kind === "tool_call_update") {
    toolCalls.push({ at: Date.now() - started, kind, title: u.title, status: u.status, toolKind: u.kind, locations: u.locations });
    if (kind === "tool_call") note(`TOOL  ${u.kind ?? "?"} ${JSON.stringify(u.title ?? "")}`);
  }
};

// --------------------------------------------------------------- read loop
const dec = new TextDecoder();
let buffered = "";
let finished = false;
const timer = setTimeout(() => { note("!! deadline reached"); finished = true; child.kill("SIGKILL"); }, deadline);

const readLoop = (async () => {
  try {
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buffered += dec.decode(chunk, { stream: true });
      let i = buffered.indexOf("\n");
      while (i !== -1) {
        const line = buffered.slice(0, i).trim();
        buffered = buffered.slice(i + 1);
        i = buffered.indexOf("\n");
        if (!line) continue;
        transcriptChars += line.length;
        appendFileSync(transcriptPath, `${JSON.stringify({ dir: "in", at: Date.now() - started, raw: line })}\n`);
        let msg: any;
        try { msg = JSON.parse(line); } catch { note(`RAW   non-JSON line: ${line.slice(0, 200)}`); continue; }
        if (msg.id !== undefined && msg.method === undefined) {
          const settle = pending.get(msg.id);
          if (settle) { pending.delete(msg.id); settle(msg); }
        } else if (msg.id !== undefined && msg.method) {
          await handleAgentRequest(msg);
        } else if (msg.method) {
          handleNotification(msg);
        }
      }
    }
  } catch { /* torn down by the kill; normal exit path */ }
})();

// ------------------------------------------------------------------ the run
const result: Record<string, unknown> = { command: [command, ...commandArgs], cwd, policy };
try {
  const t0 = Date.now();
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
  });
  result.initializeMs = Date.now() - t0;
  result.initialize = init;
  note(`INIT  ok in ${result.initializeMs}ms  agent=${init?.agentInfo?.name}@${init?.agentInfo?.version}`);

  const t1 = Date.now();
  const session = await request("session/new", { cwd: laneRoot, mcpServers: [] });
  result.sessionNewMs = Date.now() - t1;
  result.sessionNew = session;
  const sessionId = session?.sessionId;
  note(`NEW   ok in ${result.sessionNewMs}ms  sessionId=${sessionId ? "yes" : "MISSING"}`);
  // #2's central question: does `session/new` carry the model list that
  // `initialize` did not?
  note(`NEW   models=${JSON.stringify(session?.models ?? session?.modelState ?? null)}`);
  note(`NEW   modes=${JSON.stringify(session?.modes ?? null)}`);

  // The Claude bridge opens sessions in `bypassPermissions`, which routes every
  // write around the client. If a lane is to mean anything the mode has to be
  // set back — and whether that is honoured is the measurement.
  if (modeId) {
    try {
      const sm = await request("session/set_mode", { sessionId, modeId });
      note(`MODE  set_mode -> ${modeId} ok: ${JSON.stringify(sm)}`);
      result.setMode = sm;
    } catch (e: any) {
      note(`MODE  set_mode -> ${modeId} FAILED: ${e.message}`);
      result.setMode = { error: e.message };
    }
  }

  if (modelId) {
    try {
      const sm = await request("session/set_model", { sessionId, modelId });
      note(`MODEL set_model ok: ${JSON.stringify(sm)}`);
      result.setModel = sm;
    } catch (e: any) {
      note(`MODEL set_model FAILED: ${e.message}`);
      result.setModel = { error: e.message };
    }
  }

  const t2 = Date.now();
  const turn = await request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: promptText }],
  });
  result.promptMs = Date.now() - t2;
  result.stopReason = turn?.stopReason;
  note(`TURN  done in ${result.promptMs}ms  stopReason=${turn?.stopReason}`);
} catch (e: any) {
  note(`FAIL  ${e.message}`);
  result.error = e.message;
}

clearTimeout(timer);
finished = true;
child.kill("SIGKILL");
await readLoop;
await child.exited;

result.permissionRequests = permissionLog;
result.toolCalls = toolCalls;
result.updateCount = updateCount;
result.transcriptChars = transcriptChars;
result.stderr = stderrChunks.join("").slice(0, 4000);
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));

note(`STATS updates=${updateCount} permissionRequests=${permissionLog.length} toolCalls=${toolCalls.length} agentBytes=${transcriptChars}`);
note(`OUT   ${outDir}`);
