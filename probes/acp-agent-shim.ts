/**
 * Probe — ticket #6. What does brigadier have to implement to *be* an ACP agent,
 * and how does a fan-out fit inside one `session/prompt` turn?
 *
 * This is the smallest thing that answers those questions concretely: an ACP
 * agent speaking newline-delimited JSON-RPC on stdio, which on a prompt turn
 * runs N simulated slices concurrently and streams their progress back.
 *
 * It answers the "which methods are mandatory" question by implementing ONLY the
 * ones it believes are required, and rejecting everything else with -32601 — so
 * a client that needs more will say so rather than silently degrade.
 *
 * Slices are simulated rather than real agents on purpose: the question here is
 * the protocol shape of a long fan-out inside one turn, not whether the agents
 * work (that is #14).
 *
 * Usage: bun acp-agent-shim.ts [--slices N] [--slice-ms MS] [--forward-permission]
 */

const argv = Bun.argv.slice(2);
const flag = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : (argv[i + 1] ?? d);
};
const SLICES = Number(flag("slices", "3"));
const SLICE_MS = Number(flag("slice-ms", "1500"));
const FORWARD_PERMISSION = argv.includes("--forward-permission");

let nextId = 1000;
const pending = new Map<number, (v: any) => void>();

const write = (m: unknown) => {
  process.stdout.write(`${JSON.stringify(m)}\n`);
};
const notify = (method: string, params: unknown) => write({ jsonrpc: "2.0", method, params });
const request = (method: string, params: unknown): Promise<any> => {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    write({ jsonrpc: "2.0", id, method, params });
  });
};

const sessions = new Map<string, { cwd: string; cancelled: boolean }>();

const sessionUpdate = (sessionId: string, update: unknown) =>
  notify("session/update", { sessionId, update });

// ---------------------------------------------------------------- the turn
async function runTurn(sessionId: string, promptText: string): Promise<string> {
  const session = sessions.get(sessionId)!;

  // A fan-out is a plan — the only structured multi-item progress channel ACP
  // has, so this is where slices belong.
  //
  // Progress is reported by RE-SENDING the whole `plan`, not by `plan_update`.
  // Measured against Zed 1.15.0 (#48): `plan_update` is marked **UNSTABLE** in
  // the schema ("not part of the spec yet, and may be removed or changed at any
  // point") and Zed silently ignores it — the task list rendered once and then
  // sat on three pending spinners for the whole turn while every slice
  // finished. `plan` is stable and carries its entries at the top level.
  const entries = Array.from({ length: SLICES }, (_, i) => ({
    content: `slice ${i + 1}: ${promptText.slice(0, 40)}`,
    priority: "medium" as const,
    status: "pending" as string,
  }));
  const publishPlan = () =>
    sessionUpdate(sessionId, { sessionUpdate: "plan", entries: entries.map((e) => ({ ...e })) });
  publishPlan();

  // Each slice is its own tool call, so a client that renders tool calls shows
  // per-slice progress without understanding anything about brigadier.
  const runSlice = async (i: number) => {
    const toolCallId = `slice-${i + 1}`;
    entries[i].status = "in_progress";
    publishPlan();
    sessionUpdate(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId,
      title: `slice ${i + 1}`,
      kind: "other",
      status: "pending",
      locations: [{ path: `${session.cwd}/slice-${i + 1}` }],
    });

    await Bun.sleep(SLICE_MS * (i + 1));
    if (session.cancelled) {
      sessionUpdate(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
      return "cancelled";
    }

    // Does a permission request from *brigadier as agent* work, and is it
    // forwardable? This is the sub-agent's request travelling upward.
    if (FORWARD_PERMISSION && i === 0) {
      try {
        const outcome = await request("session/request_permission", {
          sessionId,
          toolCall: {
            toolCallId,
            title: `slice ${i + 1} wants to write outside its clone`,
            kind: "edit",
            locations: [{ path: `${session.cwd}/slice-${i + 1}/out.txt` }],
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Deny", kind: "reject_once" },
          ],
        });
        sessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `[slice ${i + 1}] permission outcome: ${JSON.stringify(outcome)}\n` },
        });
      } catch (e: any) {
        sessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `[slice ${i + 1}] permission FAILED: ${e.message}\n` },
        });
      }
    }

    sessionUpdate(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
    // Mark only THIS slice done and re-publish. The previous version derived
    // every entry's status from the finishing slice's index, so slices
    // completing out of order flipped already-finished ones back to
    // in_progress — a progress display that goes backwards.
    entries[i].status = "completed";
    publishPlan();
    return "ok";
  };

  const results = await Promise.all(Array.from({ length: SLICES }, (_, i) => runSlice(i)));

  sessionUpdate(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `${results.filter((r) => r === "ok").length}/${SLICES} slices completed.\n` },
  });

  if (session.cancelled) return "cancelled";
  return "end_turn";
}

// ------------------------------------------------------------- dispatch
const handle = async (msg: any) => {
  const { id, method, params } = msg;
  const ok = (result: unknown) => write({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => write({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: 1,
        agentInfo: { name: "brigadier-shim", title: "brigadier (probe shim)", version: "0.0.0" },
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
        },
        authMethods: [],
      });

    case "session/new": {
      const sessionId = `sess-${Math.floor(performance.now())}`;
      sessions.set(sessionId, { cwd: params?.cwd ?? "", cancelled: false });
      return ok({ sessionId });
    }

    case "session/prompt": {
      const sessionId = params?.sessionId;
      if (!sessions.has(sessionId)) return fail(-32602, "unknown session");
      const text = (params?.prompt ?? []).map((b: any) => b.text ?? "").join(" ");
      const stopReason = await runTurn(sessionId, text);
      return ok({ stopReason });
    }

    case "session/cancel": {
      // A notification in ACP, not a request — no id, so no reply.
      const s = sessions.get(params?.sessionId);
      if (s) s.cancelled = true;
      return;
    }

    default:
      // Deliberately not implemented, so a client that needs it complains.
      if (id !== undefined) fail(-32601, `not implemented: ${method}`);
      else process.stderr.write(`unhandled notification: ${method}\n`);
  }
};

const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let i = buf.indexOf("\n");
  while (i !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    i = buf.indexOf("\n");
    if (!line) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && msg.method === undefined) {
      const settle = pending.get(msg.id);
      if (settle) { pending.delete(msg.id); settle(msg); }
    } else {
      handle(msg).catch((e) => process.stderr.write(`handler error: ${e}\n`));
    }
  }
}
