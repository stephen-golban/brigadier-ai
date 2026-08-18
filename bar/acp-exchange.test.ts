// SPDX-License-Identifier: Apache-2.0
/**
 * The ACP fixture, driven directly — the deadlock proof.
 *
 * MEASURED on this host on 2026-08-18: `bar/fakes/vendor.ts` awaited its own
 * `actOverAcp` **inside the body of** `for await (… Bun.stdin.stream())`. While
 * a `session/request_permission` was outstanding the fixture had therefore
 * stopped reading stdin, and the client's reply to that very request arrives on
 * stdin. Nothing could ever answer it. The `--live` bar then died on the
 * harness deadline with no run record written at all, and items 2, 3, 4, 9, 11
 * and 12 were recorded as product defects the product had not committed.
 *
 * Every earlier check of this fixture went through the whole bar, so the only
 * signal available was "the run timed out" — which is the same signal a slow
 * product, a wedged `git` and a broken clone all produce. This file drives the
 * fixture on its own stdin and stdout instead and asserts on the BYTES: the
 * `initialize` result, the `session/new` result, the permission request the
 * fixture raises, the `stopReason` that closes the turn, the file the turn was
 * for, and the ledger line the process had to exist to write.
 *
 * **The negative control is the second block.** A test that a deadlock is
 * absent is worth nothing unless it can be shown to fail when the deadlock is
 * present, so the second block reconstructs the exact defect — the real source,
 * with the two dispatch calls textually replaced by an `await` in the loop
 * body — and runs the SAME exchange against it. That variant must get as far as
 * raising the permission request and no further. Ruling 62's demonstrated
 * negative, applied to a concurrency bug rather than to a predicate.
 *
 * This client does not repeat the fixture's mistake: its reader is a detached
 * task appending to an array, and every wait below is bounded and polls that
 * array. A test harness for a deadlock that could itself deadlock would be
 * indistinguishable from a passing one until it hung CI.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { derive } from "./lib/derive.ts";
import { isolatedPath, plantBrigadierShim } from "./lib/fixtures.ts";
import { writeScript } from "./lib/fs.ts";
import { readLedger } from "./lib/ledger.ts";
import type { Directive } from "./lib/plan.ts";

const VENDOR = fileURLToPath(new URL("./fakes/vendor.ts", import.meta.url));
const LIB_URL = new URL("./lib/", import.meta.url).href;

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-acp-exchange-")));
const emptyConfigHome = join(scratch, "xdg");
mkdirSync(emptyConfigHome, { recursive: true });
const started: Bun.Subprocess[] = [];

/** Real git, because the thing under test is whether the fixture COMMITS. */
function git(cwd: string, ...args: string[]): { code: number | null; out: string } {
  const proc = Bun.spawnSync(["git", "-c", "user.email=t@e.invalid", "-c", "user.name=t", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, out: new TextDecoder().decode(proc.stdout).trim() };
}

afterAll(() => {
  // Cleanup FIRST, and never downstream of a wait on anything that might be
  // wedged — the whole subject of this file is a process that never finishes.
  for (const proc of started) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already exited, which is the outcome the tests below assert.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

interface Message {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/**
 * A minimal ACP client: writes lines, and reads them on a task of its own.
 *
 * The read task is deliberately NOT awaited by anything that sends, which is
 * the property the fixture lost.
 */
class Client {
  readonly seen: Message[] = [];
  readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;

  constructor(script: string, configPath: string, cwd: string, envOverrides: Record<string, string> = {}) {
    this.proc = Bun.spawn([process.execPath, script, configPath, "--acp"], {
      cwd,
      // `XDG_CONFIG_HOME` is pinned at an empty directory on purpose: the
      // fixture reads an ambient instruction file the way a real agent does, and
      // a developer who happened to have one would change how many permission
      // requests this exchange contains. Item 9 owns that behaviour; this file
      // must not inherit it from whoever is running the suite.
      env: { ...process.env, XDG_CONFIG_HOME: emptyConfigHome, ...envOverrides },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }) as Bun.Subprocess<"pipe", "pipe", "pipe">;
    started.push(this.proc);
    void this.read();
  }

  private async read(): Promise<void> {
    let buffer = "";
    try {
      for await (const chunk of this.proc.stdout) {
        buffer += new TextDecoder().decode(chunk as Uint8Array);
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (line.length === 0) continue;
          try {
            this.seen.push(JSON.parse(line) as Message);
          } catch {
            // Not JSON: the fixture writes nothing else on stdout in ACP mode,
            // so anything here is a finding for the assertions, not a crash.
          }
        }
      }
    } catch {
      // The pipe closed under us because the process was killed. Expected in
      // the negative control, where the process never exits on its own.
    }
  }

  send(message: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    this.proc.stdin.flush();
  }

  /** A request, and the id it was sent under. Responses are matched on it. */
  request(method: string, params: unknown): number {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return id;
  }

  /** Bounded, always. Returns undefined rather than hanging. */
  async waitFor(match: (m: Message) => boolean, budgetMs: number): Promise<Message | undefined> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const found = this.seen.find(match);
      if (found !== undefined) return found;
      if (Date.now() >= deadline) return undefined;
      await Bun.sleep(10);
    }
  }

  close(): void {
    try {
      this.proc.stdin.end();
    } catch {
      // Already closed.
    }
  }
}

const responseTo = (id: number) => (m: Message) => m.id === id && m.method === undefined;
const permissionRequest = (m: Message): boolean => m.method === "session/request_permission";

/** The text of every `agent_message_chunk` the fixture streamed. */
function chunks(client: Client): string {
  return client.seen
    .filter((m) => m.method === "session/update")
    .map((m) => {
      const update = (m.params as { update?: { content?: { text?: string } } })?.update;
      return update?.content?.text ?? "";
    })
    .join("\n");
}

interface Bed {
  clone: string;
  configPath: string;
  ledger: string;
  directive: Directive;
  expected: string;
  target: string;
}

/**
 * A clone with a nonce in it, and a directive that can only be satisfied by
 * reading that nonce. The expected value is derived here and never handed over,
 * so a fixture that answered without doing the work would fail the last
 * assertion rather than the first.
 */
function bed(name: string): Bed {
  const root = join(scratch, name);
  const clone = join(root, "clone");
  mkdirSync(join(clone, "seeds"), { recursive: true });
  const seed = `seed-${name}-2f9c81`;
  writeFileSync(join(clone, "seeds", "one.seed"), `${seed}\n`);

  // A real repository, because brigadier's own worker brief tells the agent to
  // COMMIT and ruling 56 forbids brigadier from running git in a clone an agent
  // has touched. A fixture that only wrote files left the product a correct,
  // empty diff — which is what nine of eleven live failures cascaded from.
  git(clone, "init", "-q", "-b", "work", ".");
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "base");

  const ledger = join(root, "ledger.tsv");
  const configPath = join(root, "copilot.vendor.json");
  writeFileSync(configPath, JSON.stringify({ id: "copilot", version: "1.0.80", ledger }, null, 2));

  return {
    clone,
    configPath,
    ledger,
    directive: { do: "derive-write", read: "seeds/one.seed", path: "out.txt", salt: "exchange" },
    expected: derive(seed, "exchange"),
    target: join(clone, "out.txt"),
  };
}

function prompt(directive: Directive): unknown {
  return {
    sessionId: "ignored-by-the-fixture",
    prompt: [
      {
        type: "text",
        text: `item: exchange-1\nwrite the derived value\n<BAR-DIRECTIVE>${JSON.stringify(directive)}</BAR-DIRECTIVE>`,
      },
    ],
  };
}

/** Wait for an exit without blocking cleanup on one that never comes. */
async function exitedWithin(proc: Bun.Subprocess, budgetMs: number): Promise<number | null> {
  const deadline = Date.now() + budgetMs;
  while (proc.exitCode === null && proc.signalCode === null && Date.now() < deadline) await Bun.sleep(20);
  return proc.exitCode;
}

describe("the fixture completes a permission exchange it raised itself", () => {
  test("initialize, session/new, prompt, permission request, answer, end_turn", async () => {
    const b = bed("fixed");
    const client = new Client(VENDOR, b.configPath, b.clone);

    const initId = client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const init = await client.waitFor(responseTo(initId), 20_000);
    expect((init?.result as { agentInfo?: { name?: string } })?.agentInfo?.name).toBe("copilot");
    expect((init?.result as { protocolVersion?: number })?.protocolVersion).toBe(1);

    const newId = client.request("session/new", { cwd: b.clone, mcpServers: [] });
    const session = await client.waitFor(responseTo(newId), 20_000);
    const sessionId = (session?.result as { sessionId?: string })?.sessionId;
    expect(sessionId).toMatch(/^bar-copilot-\d+$/);

    // THE EXCHANGE. Before the fix the next line was the last thing that
    // happened: the fixture raised its request and stopped reading, so the
    // answer below could never be seen and `end_turn` never arrived.
    const promptId = client.request("session/prompt", prompt(b.directive));
    const ask = await client.waitFor(permissionRequest, 20_000);
    expect(ask).toBeDefined();
    const askParams = ask?.params as {
      toolCall?: { kind?: string; locations?: Array<{ path?: string }> };
      options?: Array<{ optionId?: string }>;
    };
    expect(askParams?.toolCall?.kind).toBe("edit");
    expect(askParams?.toolCall?.locations?.[0]?.path).toBe(b.target);
    expect(askParams?.options?.map((o) => o.optionId)).toEqual(["allow-once", "reject-once"]);

    client.send({
      jsonrpc: "2.0",
      id: ask?.id,
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });

    const done = await client.waitFor(responseTo(promptId), 20_000);
    expect((done?.result as { stopReason?: string })?.stopReason).toBe("end_turn");

    // The turn is not the point; the work is. The value is a hash of a nonce
    // that exists only inside the clone, so this cannot be satisfied by
    // replaying anything the client sent.
    expect(existsSync(b.target)).toBe(true);
    expect(readFileSync(b.target, "utf8").trim()).toBe(b.expected);

    // AND IT IS COMMITTED. Read out of the object store rather than off the
    // working tree: ruling 56 forbids brigadier from running git inside a clone
    // an agent has touched, so anything left uncommitted is invisible to it and
    // "the file exists on disk" is not the claim that matters.
    expect(git(b.clone, "show", "HEAD:out.txt").out).toBe(b.expected);
    expect(git(b.clone, "status", "--porcelain").out).toBe("");
    expect(git(b.clone, "rev-list", "--count", "HEAD").out).toBe("2");

    // A ledger line is a file a process had to exist to write.
    expect(readLedger(b.ledger).map((l) => `${l.vendor}/${l.role}/${l.item}`)).toEqual(["copilot/builder/exchange-1"]);

    client.close();
    expect(await exitedWithin(client.proc, 20_000)).toBe(0);
  }, 90_000);

  test("a REJECTED answer is honoured, so 'allow' is read rather than assumed", async () => {
    const b = bed("rejected");
    const client = new Client(VENDOR, b.configPath, b.clone);

    const initId = client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(await client.waitFor(responseTo(initId), 20_000)).toBeDefined();
    const newId = client.request("session/new", { cwd: b.clone, mcpServers: [] });
    expect(await client.waitFor(responseTo(newId), 20_000)).toBeDefined();

    const promptId = client.request("session/prompt", prompt(b.directive));
    const ask = await client.waitFor(permissionRequest, 20_000);
    expect(ask).toBeDefined();
    client.send({
      jsonrpc: "2.0",
      id: ask?.id,
      result: { outcome: { outcome: "selected", optionId: "reject-once" } },
    });

    const done = await client.waitFor(responseTo(promptId), 20_000);
    expect((done?.result as { stopReason?: string })?.stopReason).toBe("end_turn");
    // The turn still closes — that is what makes the deadlock the bug rather
    // than the denial — and nothing was written.
    expect(existsSync(b.target)).toBe(false);

    // NEGATIVE CONTROL for the commit: the same code path, denied, leaves the
    // history exactly where it was. Without this the assertion above would pass
    // just as well against a fixture that committed unconditionally, which would
    // make every lane check in the bar meaningless.
    expect(git(b.clone, "rev-list", "--count", "HEAD").out).toBe("1");
    expect(git(b.clone, "status", "--porcelain").out).toBe("");

    client.close();
    expect(await exitedWithin(client.proc, 20_000)).toBe(0);
  }, 90_000);

  test("the handshake is still answered while a turn is in flight", async () => {
    // `commit-then-hang` never finishes on purpose. A fixture that chained
    // every request behind the turn would have swapped the deadlock for a
    // stall, so this asserts the reader is live AND unqueued.
    const b = bed("in-flight");
    const client = new Client(VENDOR, b.configPath, b.clone);

    const initId = client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(await client.waitFor(responseTo(initId), 20_000)).toBeDefined();
    const newId = client.request("session/new", { cwd: b.clone, mcpServers: [] });
    expect(await client.waitFor(responseTo(newId), 20_000)).toBeDefined();

    const hang: Directive = { do: "commit-then-hang", read: "seeds/one.seed", path: "out.txt", salt: "exchange" };
    const promptId = client.request("session/prompt", prompt(hang));
    const ask = await client.waitFor(permissionRequest, 20_000);
    expect(ask).toBeDefined();
    client.send({
      jsonrpc: "2.0",
      id: ask?.id,
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });

    // The work lands, and then the turn hangs — deliberately.
    const deadline = Date.now() + 20_000;
    while (!existsSync(b.target) && Date.now() < deadline) await Bun.sleep(20);
    expect(readFileSync(b.target, "utf8").trim()).toBe(b.expected);
    // Committed BEFORE the hang, which is what item 7 needs: an interrupted
    // clone that really has work in it, so retaining it is worth doing.
    const committed = Date.now() + 20_000;
    while (git(b.clone, "rev-list", "--count", "HEAD").out !== "2" && Date.now() < committed) await Bun.sleep(20);
    expect(git(b.clone, "show", "HEAD:out.txt").out).toBe(b.expected);

    // With that turn wedged forever, an unrelated request is still answered.
    const modeId = client.request("session/set_mode", { sessionId: "whatever", modeId: "default" });
    expect(await client.waitFor(responseTo(modeId), 20_000)).toBeDefined();
    // And the turn really is still open, which is what the item that uses this
    // directive depends on.
    expect(client.seen.find(responseTo(promptId))).toBeUndefined();

    client.proc.kill("SIGKILL");
  }, 90_000);
});

describe("NEGATIVE CONTROL: the same exchange against the deadlock, reconstructed", () => {
  /**
   * The defect, rebuilt from the real source rather than from memory.
   *
   * The two dispatch calls in the read loop are replaced by an `await` of the
   * same handler, which is character-for-character what the file did before
   * this fix. If a future edit removes that shape from the source, the
   * replacement below matches nothing and this test fails loudly — which is the
   * correct outcome: a negative control that has quietly stopped reproducing
   * anything is worse than none.
   */
  function deadlockedCopy(): string {
    const source = readFileSync(VENDOR, "utf8");
    const DISPATCH = /if \(method === "session\/prompt"\) dispatchInTurnOrder\(handle\);\s*else dispatchNow\(handle\);/;
    expect(DISPATCH.test(source)).toBe(true);
    // Relative imports are rewritten to absolute `file:` URLs because the copy
    // lives outside `bar/`. Nothing else about the file changes.
    const rewritten = source
      .replace(DISPATCH, "await handle();")
      .split('from "../lib/')
      .join(`from "${LIB_URL}`);
    const path = join(scratch, "deadlocked-vendor.ts");
    writeFileSync(path, rewritten);
    return path;
  }

  test("it raises the permission request and can never receive the answer", async () => {
    const b = bed("deadlocked");
    const client = new Client(deadlockedCopy(), b.configPath, b.clone);

    const initId = client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(await client.waitFor(responseTo(initId), 20_000)).toBeDefined();
    const newId = client.request("session/new", { cwd: b.clone, mcpServers: [] });
    expect(await client.waitFor(responseTo(newId), 20_000)).toBeDefined();

    const promptId = client.request("session/prompt", prompt(b.directive));
    // It gets exactly this far, and this is why the failure was so uninformative
    // from outside: the fixture looks alive and is spinning on nothing.
    const ask = await client.waitFor(permissionRequest, 20_000);
    expect(ask).toBeDefined();

    client.send({
      jsonrpc: "2.0",
      id: ask?.id,
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });

    // 8 s against a fixture that answers the same exchange in well under one,
    // and far below the fixture's own 120 s permission deadline — so this is
    // the deadlock, not that deadline expiring.
    expect(await client.waitFor(responseTo(promptId), 8_000)).toBeUndefined();
    expect(existsSync(b.target)).toBe(false);
    expect(client.proc.exitCode).toBeNull();

    client.proc.kill("SIGKILL");
    expect(await exitedWithin(client.proc, 20_000)).toBeNull();
  }, 120_000);
});

/**
 * Route 2 of finding 114, at the unit the live run could not read.
 *
 * MEASURED on this host on 2026-08-18: item 9's shim ledger came back COMPLETELY
 * EMPTY from a live run. The cause was in this fixture — `actOverAcp` folded
 * `delegate` in with `derive-write` and never invoked `brigadier` at all — but
 * from outside, an empty ledger reads identically whether the worker never
 * tried (the product working) or the shim was unreachable (the harness
 * measuring nothing). Ruling 57 names that ambiguity as the thing item 9 exists
 * to settle, so it cannot be the thing item 9 produces.
 *
 * Both readings are driven here against the REAL shim from `bar/lib/fixtures.ts`
 * rather than a hand-rolled stand-in, so the bytes asserted are the bytes item 9
 * will see.
 */
describe("the delegate directive really calls `brigadier`, and an empty ledger is readable", () => {
  /** A `brigadier` that refuses exactly as ruling 57 requires: exit 3. */
  function shimmedBin(name: string, ledger: string): string {
    const binDir = join(scratch, `${name}-bin`);
    mkdirSync(binDir, { recursive: true });
    const real = writeScript(
      join(binDir, "real-brigadier"),
      "#!/bin/sh\necho 'this session IS a brigadier worker; do the work directly' >&2\nexit 3\n",
      "@echo off\r\nexit /b 3\r\n",
    );
    plantBrigadierShim(binDir, ledger, real);
    return binDir;
  }

  async function drive(client: Client, b: Bed): Promise<void> {
    const initId = client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(await client.waitFor(responseTo(initId), 20_000)).toBeDefined();
    const newId = client.request("session/new", { cwd: b.clone, mcpServers: [] });
    expect(await client.waitFor(responseTo(newId), 20_000)).toBeDefined();

    const delegate: Directive = { do: "delegate", read: "seeds/one.seed", path: "out.txt", salt: "exchange" };
    const promptId = client.request("session/prompt", prompt(delegate));
    const ask = await client.waitFor(permissionRequest, 20_000);
    expect(ask).toBeDefined();
    client.send({ jsonrpc: "2.0", id: ask?.id, result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
    const done = await client.waitFor(responseTo(promptId), 20_000);
    expect((done?.result as { stopReason?: string })?.stopReason).toBe("end_turn");
  }

  test("the shim records the attempt, the marker, and the refusal", async () => {
    if (process.platform === "win32") return; // the shim's POSIX form is what item 9 plants
    const b = bed("delegate-reachable");
    const ledger = join(scratch, "delegate-reachable.log");
    const binDir = shimmedBin("delegate-reachable", ledger);

    const client = new Client(VENDOR, b.configPath, b.clone, {
      PATH: isolatedPath(binDir),
      BRIGADIER_WORKER: "bar-exchange/1",
    });
    await drive(client, b);

    // The bytes the shim wrote, which no report can un-write.
    expect(existsSync(ledger)).toBe(true);
    const lines = readFileSync(ledger, "utf8").trim().split("\n");
    const call = lines.find((l) => l.startsWith("CALL "));
    const doneLine = lines.find((l) => l.startsWith("DONE "));
    // CALL is written BEFORE the real binary runs, so no outcome can suppress it.
    expect(call).toContain("worker=bar-exchange/1");
    expect(call).toContain("argv: run --plan whatever");
    // DONE carries ruling 57's refusal code, so "ran and was refused" and "ran
    // and was allowed" are different readings.
    expect(doneLine).toContain("exit=3");

    // And the fixture said the same thing on the wire, so a reader who has only
    // the transcript reaches the same conclusion as one who has the ledger.
    expect(chunks(client)).toContain("DELEGATION-REFUSED");

    // And the work still happened and was committed: the worker did the job
    // rather than delegating it.
    expect(git(b.clone, "show", "HEAD:out.txt").out).toBe(b.expected);

    client.close();
    expect(await exitedWithin(client.proc, 20_000)).toBe(0);
  }, 90_000);

  test("NEGATIVE CONTROL: with no shim on PATH the ledger stays empty and the fixture SAYS so", async () => {
    if (process.platform === "win32") return;
    const b = bed("delegate-unreachable");
    const ledger = join(scratch, "delegate-unreachable.log");
    shimmedBin("delegate-unreachable", ledger); // planted, and deliberately NOT on PATH

    const bare = join(scratch, "empty-bin");
    mkdirSync(bare, { recursive: true });
    const client = new Client(VENDOR, b.configPath, b.clone, {
      PATH: isolatedPath(bare),
      BRIGADIER_WORKER: "bar-exchange/2",
    });
    await drive(client, b);

    // THE POINT. The ledger is empty here for a completely different reason
    // than "the worker never tried", and the two must not look alike.
    expect(existsSync(ledger)).toBe(false);
    client.close();
    expect(await exitedWithin(client.proc, 20_000)).toBe(0);
    // The fixture reported the unreachable shim rather than failing silently,
    // which is what lets item 9 call this a finding about environment
    // propagation instead of an absence of evidence.
    // Said on the wire...
    expect(chunks(client)).toContain("could NOT spawn");
    // UNREACHABLE, not ACCEPTED. A call that never happened cannot have been
    // allowed, and labelling it so would tell item 9 the product failed to
    // refuse something the product never saw.
    expect(chunks(client)).toContain("DELEGATION-UNREACHABLE");
    // ...and on stderr, which the harness captures even when it does not read
    // the protocol. A finding reachable through only one channel is a finding
    // that gets lost.
    const stderr = await new Response(client.proc.stderr).text();
    expect(stderr).toContain("could NOT spawn");
  }, 90_000);
});
