// SPDX-License-Identifier: Apache-2.0
/**
 * `brigadier serve`, driven over a real `Connection` on a real `LineChannel`.
 *
 * Nothing here spawns a process. The server is exercised through
 * `memoryChannel`, which is the seam `src/acp/channel.ts` exists to provide, so
 * every assertion is on the BYTES that would go on the wire rather than on a
 * method's return value — the same reason `Worker` is tested that way.
 *
 * Every wait is bounded. `until` has a deadline and throws with what it was
 * waiting for, because a server test that hangs poisons the whole round.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { memoryChannel } from "../src/acp/channel.ts";
import { Connection } from "../src/acp/connection.ts";
import { NO_DIAGNOSTICS, stdioChannel } from "../src/acp/stdio.ts";
import { unsinkedWrites } from "../src/secrets/audit.ts";
import {
  ADMIT_STAGES,
  NOTHING_WAS_STARTED,
  admitPlan,
  PROMPT_CONTRACT,
  PROTOCOL_VERSION,
  Server,
  TurnPlan,
  UnknownPlanEntry,
  planPathFrom,
  type AdmitOutcome,
  type StageReporter,
} from "../src/serve/index.ts";

const ROOT = new URL("..", import.meta.url).pathname;

// --------------------------------------------------------------- harness

interface Frame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function until(what: string, check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}

function harness(admit?: ConstructorParameters<typeof Server>[0]["admit"]) {
  const channel = memoryChannel();
  const server = new Server({
    notify: (method, params) => connection.notify(method, params),
    defaultCwd: ROOT,
    version: "test",
    ...(admit === undefined ? {} : { admit }),
  });
  const connection = new Connection(channel, {
    onRequest: server.onRequest,
    onNotification: server.onNotification,
  });

  let nextId = 1;
  const frames = (): Frame[] => channel.sent.map((line) => JSON.parse(line) as Frame);

  return {
    server,
    frames,
    /** Send a client→agent request and return its id. */
    send(method: string, params: unknown): number {
      const id = nextId++;
      channel.deliver(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return id;
    },
    notify(method: string, params: unknown): void {
      channel.deliver(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
    async reply(id: number): Promise<Frame> {
      await until(`a reply to request ${id}`, () => frames().some((f) => f.id === id));
      return frames().find((f) => f.id === id)!;
    },
    /** Every `session/update` of one kind, in order. */
    updates(kind: string): Array<Record<string, unknown>> {
      return frames()
        .filter((f) => f.method === "session/update")
        .map((f) => (f.params as { update?: Record<string, unknown> } | undefined)?.update)
        .filter((u): u is Record<string, unknown> => u !== undefined && u["sessionUpdate"] === kind);
    },
    async close(): Promise<void> {
      await connection.close();
    },
  };
}

/** A turn that stops in the middle until the test lets it go. */
function gatedAdmit(lines: string[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const admit = async (_request: unknown, stages: StageReporter): Promise<AdmitOutcome> => {
    stages.start(ADMIT_STAGES[0]);
    stages.finish(ADMIT_STAGES[0]);
    entered = true;
    await gate;
    if (!(await stages.keepGoing())) return { admitted: false, cancelled: true, lines: ["cancelled mid-turn"] };
    for (const stage of ADMIT_STAGES.slice(1)) {
      stages.start(stage);
      stages.finish(stage);
    }
    return { admitted: true, cancelled: false, lines };
  };
  return { admit: admit as ConstructorParameters<typeof Server>[0]["admit"], release, hasEntered: () => entered };
}

async function opened(h: ReturnType<typeof harness>): Promise<string> {
  const init = h.send("initialize", { protocolVersion: PROTOCOL_VERSION });
  await h.reply(init);
  const created = h.send("session/new", { cwd: ROOT });
  const reply = await h.reply(created);
  return (reply.result as { sessionId: string }).sessionId;
}

// ------------------------------------------------------- the plan channel

describe("ruling 2's plan channel: the whole stable plan, re-sent, mutated by identity", () => {
  test("an entry moves pending → in_progress → completed under its own name", () => {
    const plan = new TurnPlan(["a", "b", "c"]);
    expect(plan.entries().map((e) => e.status)).toEqual(["pending", "pending", "pending"]);
    plan.start("b");
    expect(plan.entries()).toEqual([
      { content: "a", priority: "medium", status: "pending" },
      { content: "b", priority: "medium", status: "in_progress" },
      { content: "c", priority: "medium", status: "pending" },
    ]);
    plan.finish("b");
    expect(plan.entries()[1]!.status).toBe("completed");
  });

  /**
   * The bug the probe recorded on ticket #48: a version that derived every
   * entry's status from the FINISHING entry's index flipped already-completed
   * entries back to `in_progress` whenever two finished out of order, so the
   * display ran backwards. Finishing c before b is that case exactly.
   */
  test("out-of-order completion never moves a finished entry backwards", () => {
    const plan = new TurnPlan(["a", "b", "c"]);
    plan.start("a");
    plan.start("b");
    plan.start("c");
    plan.finish("c");
    plan.finish("a");
    expect(plan.entries().map((e) => [e.content, e.status])).toEqual([
      ["a", "completed"],
      ["b", "in_progress"],
      ["c", "completed"],
    ]);
    plan.finish("b");
    expect(plan.unfinished()).toEqual([]);
  });

  test("entries() hands out copies, so a later mutation cannot rewrite a frame already sent", () => {
    const plan = new TurnPlan(["a"]);
    const snapshot = plan.entries();
    plan.finish("a");
    expect(snapshot[0]!.status).toBe("pending");
  });

  // NEGATIVE CONTROL for the guard above: a name the plan does not hold must
  // throw. A silent no-op is the first bug with a different cause — the list
  // renders once and then never moves, which from outside is indistinguishable
  // from work that never finished.
  test("an unknown entry name throws rather than silently doing nothing", () => {
    const plan = new TurnPlan(["a"]);
    expect(() => plan.finish("typo")).toThrow(UnknownPlanEntry);
    expect(() => plan.start("typo")).toThrow(/no plan entry named "typo"/);
    expect(plan.entries()[0]!.status).toBe("pending");
  });

  test("the pipeline and the plan read one list, so a rename cannot desynchronise them", () => {
    const plan = new TurnPlan([...ADMIT_STAGES]);
    for (const stage of ADMIT_STAGES) {
      plan.start(stage);
      plan.finish(stage);
    }
    expect(plan.unfinished()).toEqual([]);
    expect(plan.size).toBe(ADMIT_STAGES.length);
  });
});

// ------------------------------------------------------------ the methods

describe("the four methods, and -32601 to everything else", () => {
  test("initialize answers the handshake", async () => {
    const h = harness();
    const reply = await h.reply(h.send("initialize", { protocolVersion: PROTOCOL_VERSION }));
    expect(reply.error).toBeUndefined();
    const result = reply.result as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe(PROTOCOL_VERSION);
    expect((result["agentInfo"] as { name: string }).name).toBe("brigadier");
    expect(result["authMethods"]).toEqual([]);
    await h.close();
  });

  test("session/new mints a session, and several may exist at once", async () => {
    const h = harness();
    const one = (await h.reply(h.send("session/new", { cwd: ROOT }))).result as { sessionId: string };
    const two = (await h.reply(h.send("session/new", { cwd: ROOT }))).result as { sessionId: string };
    expect(one.sessionId).not.toBe(two.sessionId);
    await h.close();
  });

  test("an unimplemented method is -32601 and NOT a silent success", async () => {
    const h = harness();
    const reply = await h.reply(h.send("session/load", { sessionId: "nope" }));
    expect(reply.error?.code).toBe(-32601);
    expect(reply.result).toBeUndefined();
    await h.close();
  });

  // NEGATIVE CONTROL for the assertion above: the same channel and the same
  // Connection must NOT answer -32601 to a method that is implemented. Without
  // this, a server that answered -32601 to everything would pass the test above.
  test("a method that IS implemented does not get -32601", async () => {
    const h = harness();
    const reply = await h.reply(h.send("initialize", {}));
    expect(reply.error).toBeUndefined();
    await h.close();
  });

  test("session/prompt on a session that was never created is an error, not an empty turn", async () => {
    const h = harness();
    const reply = await h.reply(h.send("session/prompt", { sessionId: "made-up", prompt: [{ type: "text", text: "x" }] }));
    expect(reply.error?.message).toMatch(/unknown session/);
    expect(reply.result).toBeUndefined();
    await h.close();
  });
});

// -------------------------------------------------------------- the turn

describe("a turn reports through the plan and says what it did not do", () => {
  test("the plan is re-sent whole at every transition and every stage completes", async () => {
    const h = harness();
    const sessionId = await opened(h);
    const reply = await h.reply(
      h.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "--plan /nonexistent-plan.json" }] }),
    );
    expect((reply.result as { stopReason: string }).stopReason).toBe("end_turn");

    const plans = h.updates("plan");
    // Published once before the first stage, and again on every start and
    // finish. Never a `plan_update`: MEASURED against `Zed 1.15.0` on ticket
    // #48, `plan_update` is UNSTABLE and Zed silently ignores it.
    expect(plans.length).toBeGreaterThan(1);
    expect(h.updates("plan_update")).toEqual([]);
    for (const update of plans) {
      expect((update["entries"] as unknown[]).length).toBe(ADMIT_STAGES.length);
    }
    expect((plans[0]!["entries"] as Array<{ status: string }>).every((e) => e.status === "pending")).toBe(true);
    await h.close();
  });

  test("a real unreadable plan is REFUSED with its reason, and the turn says nothing was started", async () => {
    const h = harness();
    const sessionId = await opened(h);
    await h.reply(
      h.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "--plan /no/such/plan.json" }] }),
    );
    const text = h
      .updates("agent_message_chunk")
      .map((u) => ((u["content"] as { text?: string })?.text ?? ""))
      .join("");
    expect(text).toContain("/no/such/plan.json");
    expect(text).toContain(NOTHING_WAS_STARTED);
    await h.close();
  });

  test("a prompt that is not a plan path gets the contract, not a guess", async () => {
    const h = harness();
    const sessionId = await opened(h);
    const reply = await h.reply(
      h.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "please refactor the auth module" }] }),
    );
    expect((reply.result as { stopReason: string }).stopReason).toBe("end_turn");
    const text = h
      .updates("agent_message_chunk")
      .map((u) => ((u["content"] as { text?: string })?.text ?? ""))
      .join("");
    expect(text).toBe(`${PROMPT_CONTRACT}\n${NOTHING_WAS_STARTED}\n`);
    expect(h.updates("plan")).toEqual([]);
    await h.close();
  });

  test("planPathFrom takes the flag or a bare path and refuses to guess out of a sentence", () => {
    expect(planPathFrom("--plan ./plan.json")).toBe("./plan.json");
    expect(planPathFrom("  /abs/plan.json  ")).toBe("/abs/plan.json");
    expect(planPathFrom("run --plan /a/b.json now")).toBe("/a/b.json");
    // NEGATIVE CONTROL: prose containing something path-shaped must not be
    // mined for it. Admitting a file the operator did not name is worse than
    // asking.
    expect(planPathFrom("have a look at ./plan.json and tell me what you think")).toBeNull();
    expect(planPathFrom("")).toBeNull();
    expect(planPathFrom("--plan")).toBeNull();
    expect(planPathFrom("--plan --repo")).toBeNull();
  });
});

// ------------------------------------------------------- one turn at a time

describe("one turn at a time, refused visibly", () => {
  test("a second concurrent prompt is an error naming the session that holds the turn", async () => {
    const gate = gatedAdmit(["admitted"]);
    const h = harness(gate.admit);
    const first = await opened(h);
    const second = (await h.reply(h.send("session/new", { cwd: ROOT }))).result as { sessionId: string };

    const running = h.send("session/prompt", { sessionId: first, prompt: [{ type: "text", text: "/p.json" }] });
    await until("the first turn to be inside admission", gate.hasEntered);

    const refused = await h.reply(
      h.send("session/prompt", { sessionId: second.sessionId, prompt: [{ type: "text", text: "/p.json" }] }),
    );
    expect(refused.result).toBeUndefined();
    expect(refused.error?.message).toContain(first);
    expect(refused.error?.message).toMatch(/one at a time/);
    expect(h.server.busyWith).toBe(first);

    gate.release();
    expect((await h.reply(running)).result).toEqual({ stopReason: "end_turn" });

    // NEGATIVE CONTROL for the guard: once the turn is over the same prompt
    // must SUCCEED. Without this, a server that refused every prompt after the
    // first would pass the assertion above.
    await until("the turn slot to be free", () => h.server.busyWith === null);
    const later = await h.reply(
      h.send("session/prompt", { sessionId: second.sessionId, prompt: [{ type: "text", text: "/p.json" }] }),
    );
    expect(later.error).toBeUndefined();
    expect((later.result as { stopReason: string }).stopReason).toBe("end_turn");
    await h.close();
  });

  test("a turn that throws releases the slot rather than wedging the server", async () => {
    const boom = (async () => {
      throw new Error("planted");
    }) as ConstructorParameters<typeof Server>[0]["admit"];
    const h = harness(boom);
    const sessionId = await opened(h);
    const reply = await h.reply(
      h.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "/p.json" }] }),
    );
    expect((reply.result as { stopReason: string }).stopReason).toBe("end_turn");
    const text = h
      .updates("agent_message_chunk")
      .map((u) => ((u["content"] as { text?: string })?.text ?? ""))
      .join("");
    expect(text).toContain("admission failed: planted");
    // D1, the defect a blind critic found on the real binary: this arm used to
    // answer `end_turn` and never say that nothing had run.
    expect(text).toContain(NOTHING_WAS_STARTED);
    expect(h.server.busyWith).toBeNull();
    await h.close();
  });
});

// ------------------------------------------------------------- cancellation

describe("session/cancel is a notification and it reaches a turn already running", () => {
  test("a cancel delivered mid-turn stops the pipeline and the stop reason says so", async () => {
    const gate = gatedAdmit(["admitted"]);
    const h = harness(gate.admit);
    const sessionId = await opened(h);
    const running = h.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "/p.json" }] });
    await until("the turn to be inside admission", gate.hasEntered);

    h.notify("session/cancel", { sessionId });
    // The notification has to be READ before the turn resumes, which is the
    // whole reason `keepGoing` is awaited between stages.
    await Bun.sleep(20);
    gate.release();

    const reply = await h.reply(running);
    expect((reply.result as { stopReason: string }).stopReason).toBe("cancelled");
    await h.close();
  });

  // NEGATIVE CONTROL: the same turn, with no cancel, must NOT report
  // `cancelled`. Without this, a turn hard-coded to say `cancelled` passes.
  test("with no cancel the same turn ends `end_turn`", async () => {
    const gate = gatedAdmit(["admitted"]);
    const h = harness(gate.admit);
    const sessionId = await opened(h);
    const running = h.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "/p.json" }] });
    await until("the turn to be inside admission", gate.hasEntered);
    await Bun.sleep(20);
    gate.release();
    expect(((await h.reply(running)).result as { stopReason: string }).stopReason).toBe("end_turn");
    await h.close();
  });

  test("a cancel for a session that does not exist is ignored rather than thrown", async () => {
    const h = harness();
    h.notify("session/cancel", { sessionId: "made-up" });
    h.notify("session/cancel", {});
    const reply = await h.reply(h.send("initialize", {}));
    expect(reply.error).toBeUndefined();
    await h.close();
  });
});

// --------------------------------------------------------- the stdio channel

describe("the stdio LineChannel", () => {
  function source(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  test("frames are split on newlines however the chunks fall", async () => {
    const written: string[] = [];
    const channel = stdioChannel({ writeLine: (line) => written.push(line), input: source(['{"a":1}\n{"b', '":2}\n']) });
    const got: string[] = [];
    for await (const line of channel.lines()) got.push(line);
    expect(got).toEqual(['{"a":1}', '{"b":2}']);
    channel.send("out");
    expect(written).toEqual(["out"]);
    await channel.close();
  });

  test("a last frame with no trailing newline is delivered, not dropped", async () => {
    const channel = stdioChannel({ writeLine: () => {}, input: source(['{"a":1}\n{"b":2}']) });
    const got: string[] = [];
    for await (const line of channel.lines()) got.push(line);
    expect(got).toEqual(['{"a":1}', '{"b":2}']);
    await channel.close();
  });

  test("close() ends the iteration and stops further sends", async () => {
    const written: string[] = [];
    const never = new ReadableStream<Uint8Array>({ start() {} });
    const channel = stdioChannel({ writeLine: (line) => written.push(line), input: never });
    const drained = (async () => {
      for await (const _ of channel.lines()) {
        // nothing arrives; close() is what ends this
      }
      return "ended";
    })();
    await channel.close();
    expect(await drained).toBe("ended");
    channel.send("after close");
    expect(written).toEqual([]);
    await channel.close();
  });

  test("diagnostics says why it has none rather than returning an empty string", () => {
    const channel = stdioChannel({ writeLine: () => {}, input: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }) });
    expect(channel.diagnostics()).toBe(NO_DIAGNOSTICS);
    expect(channel.diagnostics()).not.toBe("");
  });
});

// --------------------------------------------------------------- ruling 65

describe("ruling 65: the server adds no writer of its own", () => {
  function sources(): Map<string, string> {
    const files = new Map<string, string>();
    for (const name of readdirSync(join(ROOT, "src/serve"))) {
      if (name.endsWith(".ts")) files.set(`src/serve/${name}`, readFileSync(join(ROOT, "src/serve", name), "utf8"));
    }
    files.set("src/acp/stdio.ts", readFileSync(join(ROOT, "src/acp/stdio.ts"), "utf8"));
    return files;
  }

  test("no write primitive in src/serve/ or src/acp/stdio.ts", () => {
    // Every frame goes through the process's ONE `Sink`, handed in as
    // `writeLine`. This is the structural half of that claim: the scanner that
    // `test-gate` runs finds nothing here, so there is no route by which these
    // files could put a byte on stdout without the sink.
    expect(unsinkedWrites(sources()).map((hit) => `${hit.file}:${hit.line} ${hit.primitive}`)).toEqual([]);
  });

  // NEGATIVE CONTROL for the scan above: the same call, over the same file with
  // one writer planted in it, must report it. A scan that always returned an
  // empty list would look identical to a clean tree.
  test("and the scan fires when a writer is planted in one of them", () => {
    const planted = sources();
    const original = planted.get("src/serve/index.ts")!;
    planted.set("src/serve/index.ts", `${original}\nfunction leak(line: string) { process.stdout.write(line); }\n`);
    const found = unsinkedWrites(planted);
    expect(found.map((hit) => hit.primitive)).toEqual(["process.stdout/stderr.write"]);
    expect(found[0]!.file).toBe("src/serve/index.ts");
  });
});

// ------------------------------------------------- the turn's REAL pipeline

/**
 * The same turn, with nothing injected: `admitPlan` against a plan file on
 * disk.
 *
 * The tests above prove the protocol with admission stubbed out, which is
 * exactly the shape that lets a method report success without doing the work.
 * These drive the real pipeline and assert on the sentences it produces —
 * `describeRefusals` and `describeAdmission` are what `brigadier plan` prints,
 * so agreeing with them is the claim that this turn does that job and not a
 * lookalike.
 */
describe("session/prompt runs the real admission pipeline and stops there", () => {
  const HOME_SCRATCH = mkdtempSync(join(homedir(), ".brigadier-serve-admit-"));
  afterAll(() => rmSync(HOME_SCRATCH, { recursive: true, force: true }));

  const PLAN = join(HOME_SCRATCH, "plan.json");
  writeFileSync(
    PLAN,
    JSON.stringify({
      version: 1,
      items: [
        { id: "one", kind: "write", paths: ["one.txt"], prompt: "write one.txt" },
        { id: "two", kind: "write", paths: ["two.txt"], prompt: "write two.txt" },
      ],
    }),
  );

  function serving(which: (command: string) => string | null) {
    const channel = memoryChannel();
    const server = new Server({
      notify: (method, params) => connection.notify(method, params),
      defaultCwd: HOME_SCRATCH,
      runRoot: join(HOME_SCRATCH, "runs"),
      which,
      version: "test",
    });
    const connection = new Connection(channel, {
      onRequest: server.onRequest,
      onNotification: server.onNotification,
    });
    return { channel, connection };
  }

  async function turn(which: (command: string) => string | null) {
    const { channel, connection } = serving(which);
    channel.deliver(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: HOME_SCRATCH } }));
    await until("session/new", () => channel.sent.some((l) => (JSON.parse(l) as Frame).id === 1));
    channel.deliver(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: "brigadier-1", prompt: [{ type: "text", text: `--plan ${PLAN}` }] },
      }),
    );
    await until("the turn to answer", () => channel.sent.some((l) => (JSON.parse(l) as Frame).id === 2), 20_000);
    const frames = channel.sent.map((l) => JSON.parse(l) as Frame);
    const prose = frames
      .filter((f) => f.method === "session/update")
      .map((f) => (f.params as { update?: Record<string, unknown> } | undefined)?.update)
      .filter((u): u is Record<string, unknown> => u?.["sessionUpdate"] === "agent_message_chunk")
      .map((u) => ((u["content"] as { text?: string })?.text ?? ""))
      .join("");
    const plans = frames
      .filter((f) => f.method === "session/update")
      .map((f) => (f.params as { update?: Record<string, unknown> } | undefined)?.update)
      .filter((u): u is Record<string, unknown> => u?.["sessionUpdate"] === "plan");
    await connection.close();
    return { reply: frames.find((f) => f.id === 2)!, prose, plans };
  }

  test("no agent on PATH is a REFUSAL carrying its remedy, not an admitted plan", async () => {
    const { reply, prose } = await turn(() => null);
    expect((reply.result as { stopReason: string }).stopReason).toBe("end_turn");
    expect(prose).toContain("was not admitted, and nothing was started");
    expect(prose).toContain("no agent resolved on PATH");
    expect(prose).toContain(NOTHING_WAS_STARTED);
    // The plan is NOT snapped to all-complete: a refused turn shows how far it
    // got, and the estimate stage never ran.
    expect(prose).not.toContain("estimate  ");
  });

  // NEGATIVE CONTROL for the refusal above: with an agent resolvable, the SAME
  // plan file must be ADMITTED and priced. Without this, a pipeline that
  // refused everything would pass the test above.
  test("with an agent on PATH the same plan is admitted, priced, and still starts nothing", async () => {
    const { reply, prose, plans } = await turn((command) => (command === "qwen" ? "/planted/bin/qwen" : null));
    expect((reply.result as { stopReason: string }).stopReason).toBe("end_turn");
    expect(prose).toContain("admitted —");
    expect(prose).toContain("2 item(s)");
    expect(prose).toContain("qwen at /planted/bin/qwen");
    expect(prose).toContain("estimate");
    expect(prose).toContain(NOTHING_WAS_STARTED);

    // Every stage ran, and the last frame shows all five completed.
    const last = plans.at(-1)!["entries"] as Array<{ content: string; status: string }>;
    expect(last.map((e) => e.content)).toEqual([...ADMIT_STAGES]);
    expect(last.every((e) => e.status === "completed")).toBe(true);
  });

  // Ruling 53's property, checked from the outside: a turn that reported on a
  // plan created nothing. This is the assertion that would catch a future
  // "wired up" turn that quietly started spending.
  test("nothing was created: no run root, no clone, no ref", () => {
    expect(existsSync(join(HOME_SCRATCH, "runs"))).toBe(false);
    expect(readdirSync(HOME_SCRATCH).sort()).toEqual(["plan.json"]);
  });
});

// ------------------------------- the closing sentence, structurally

/**
 * D1/D2. Every terminal turn outcome carries `NOTHING_WAS_STARTED`, exactly
 * once, because ONE place appends it.
 *
 * A blind critic drove the real binary and found the sixth return site: an
 * admission that THREW answered `stopReason: "end_turn"` with only
 * `admission failed: ...` on the wire and no statement that nothing had run —
 * `grep -c "nothing was started"` was 0 for that turn and 1 for every other.
 * An editor renders that as a completed turn.
 *
 * The repair moved the sentence out of the five hand-written sites in
 * `src/serve/admit.ts` and into `#deliver`, which is now the only thing that
 * can answer a prompt. This table drives every path that reaches a stop reason.
 * A sixth path added later reaches `#deliver` too, because `#turnFor` returns a
 * `TurnOutcome` and has nowhere else to answer from.
 */
describe("every terminal turn outcome says nothing was started", () => {
  const outcome = (over: Partial<AdmitOutcome>): ConstructorParameters<typeof Server>[0]["admit"] =>
    (async () => ({ admitted: false, cancelled: false, lines: ["some admission prose"], ...over })) as
      ConstructorParameters<typeof Server>[0]["admit"];

  const paths: Array<[string, string, ConstructorParameters<typeof Server>[0]["admit"] | undefined, string]> = [
    ["no plan path in the prompt", "just some english", undefined, "end_turn"],
    ["a plan file that cannot be read", "/no/such/plan.json", undefined, "end_turn"],
    ["admission threw", "/p.json", (async () => { throw new Error("planted"); }) as ConstructorParameters<typeof Server>[0]["admit"], "end_turn"],
    ["admission refused", "/p.json", outcome({ admitted: false, lines: ["refused for a reason"] }), "end_turn"],
    ["admission admitted", "/p.json", outcome({ admitted: true, lines: ["admitted — 1 item(s)"] }), "end_turn"],
    ["the turn was cancelled", "/p.json", outcome({ cancelled: true, lines: ["cancelled mid-turn"] }), "cancelled"],
  ];

  for (const [name, text, admit, stopReason] of paths) {
    test(`${name} → ${stopReason}, and the sentence is there exactly once`, async () => {
      const h = harness(admit);
      const sessionId = await opened(h);
      const reply = await h.reply(h.send("session/prompt", { sessionId, prompt: [{ type: "text", text }] }));
      expect(reply.error).toBeUndefined();
      expect((reply.result as { stopReason: string }).stopReason).toBe(stopReason);
      const prose = h
        .updates("agent_message_chunk")
        .map((u) => ((u["content"] as { text?: string })?.text ?? ""))
        .join("");
      expect(prose.split(NOTHING_WAS_STARTED)).toHaveLength(2);
      // It is the LAST line, which is the claim `SERVE_USAGE` makes.
      expect(prose.trimEnd().endsWith(NOTHING_WAS_STARTED)).toBe(true);
      await h.close();
    });
  }

  /**
   * NEGATIVE CONTROL for the six assertions above. `admitPlan`'s own `lines`
   * must NOT contain the sentence — if admission still hand-appended it, the
   * table would pass while the guarantee was back to being five sites
   * remembering, and a `split()` length of 3 would be the only symptom. This is
   * the assertion that keeps the mechanism single.
   */
  test("admission itself never appends it, so the wrapper is the only source", async () => {
    const seen: string[] = [];
    const reporter: StageReporter = {
      start: (stage) => void seen.push(stage),
      finish: () => {},
      keepGoing: async () => true,
    };
    const refused = await admitPlan({ planPath: "/no/such/plan.json", repo: ROOT }, reporter);
    expect(refused.admitted).toBe(false);
    expect(refused.lines.join("\n")).not.toContain(NOTHING_WAS_STARTED);
    expect(seen).toContain(ADMIT_STAGES[0]);
  });
});

/**
 * The critic's exact reproduction, against the REAL pipeline rather than an
 * injected throw: `{"version":1,"items":[null]}` is a plan an operator can
 * write, and `validatePlan` throws on `entry.id` reading it.
 *
 * An injected `throw` proves the wrapper. Only this proves that the wrapper is
 * on the path a real malformed plan takes.
 */
describe("a real plan that makes validatePlan throw", () => {
  const SCRATCH = mkdtempSync(join(homedir(), ".brigadier-serve-throw-"));
  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

  test("the turn reports the failure AND that nothing was started", async () => {
    const plan = join(SCRATCH, "null-item.json");
    writeFileSync(plan, JSON.stringify({ version: 1, items: [null] }));

    const channel = memoryChannel();
    const server = new Server({
      notify: (method, params) => connection.notify(method, params),
      defaultCwd: SCRATCH,
      runRoot: join(SCRATCH, "runs"),
      which: (command) => (command === "qwen" ? "/planted/bin/qwen" : null),
      version: "test",
    });
    const connection = new Connection(channel, {
      onRequest: server.onRequest,
      onNotification: server.onNotification,
    });

    channel.deliver(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: SCRATCH } }));
    await until("session/new", () => channel.sent.some((l) => (JSON.parse(l) as Frame).id === 1));
    channel.deliver(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: "brigadier-1", prompt: [{ type: "text", text: `--plan ${plan}` }] },
      }),
    );
    await until("the turn to answer", () => channel.sent.some((l) => (JSON.parse(l) as Frame).id === 2), 20_000);

    const frames = channel.sent.map((l) => JSON.parse(l) as Frame);
    expect((frames.find((f) => f.id === 2)!.result as { stopReason: string }).stopReason).toBe("end_turn");
    const prose = frames
      .filter((f) => f.method === "session/update")
      .map((f) => (f.params as { update?: Record<string, unknown> } | undefined)?.update)
      .filter((u): u is Record<string, unknown> => u?.["sessionUpdate"] === "agent_message_chunk")
      .map((u) => ((u["content"] as { text?: string })?.text ?? ""))
      .join("");
    expect(prose).toContain("admission failed:");
    expect(prose).toContain(NOTHING_WAS_STARTED);
    // The plan is frozen at the stage it died on, not snapped to all-complete.
    const plans = frames
      .filter((f) => f.method === "session/update")
      .map((f) => (f.params as { update?: Record<string, unknown> } | undefined)?.update)
      .filter((u): u is Record<string, unknown> => u?.["sessionUpdate"] === "plan");
    const last = plans.at(-1)!["entries"] as Array<{ status: string }>;
    expect(last.some((e) => e.status !== "completed")).toBe(true);

    await connection.close();
    expect(existsSync(join(SCRATCH, "runs"))).toBe(false);
  }, 30_000);
});
