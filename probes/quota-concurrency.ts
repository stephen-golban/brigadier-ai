/**
 * Probe — ticket #46, part 2. What do N concurrent workers see of a SHARED quota?
 *
 * #15 established that Codex answers `account/rateLimits/read` pre-flight in
 * ~1.2 s and that Claude has no pre-flight read at all — its `rate_limit_event`
 * arrives mid-turn. Every reading in #15 was single-worker, and the ticket's own
 * title is that quota is shared.
 *
 * Decision 14 proposes a quota filter and decision 23 lets a hard ceiling cancel
 * work already in flight. Both need to know whether a reading taken at fan-out
 * time is still true when the fifth worker spawns.
 *
 * This measures the cheap half, which needs no quota to be exhausted:
 *
 *   1. Spawn N `codex app-server` processes CONCURRENTLY and have each read the
 *      rate limits at the same moment. If they disagree, a pre-flight check is
 *      reading a per-process snapshot and cannot bound a fleet.
 *   2. Read again after a delay, to see whether the number is live or cached.
 *
 * It deliberately does NOT run inference turns. Provoking the limit needs the
 * owner's consent (ruled against on 2026-08-17), and the consistency question
 * does not require it.
 *
 * Usage: bun quota-concurrency.ts [--workers 5] [--rounds 2] [--gap-ms 20000]
 */

const arg = (n: string, d: string) => {
  const i = Bun.argv.indexOf(`--${n}`);
  return i === -1 ? d : (Bun.argv[i + 1] ?? d);
};
const WORKERS = Number(arg("workers", "5"));
const ROUNDS = Number(arg("rounds", "2"));
const GAP = Number(arg("gap-ms", "20000"));

type Reading = {
  worker: number;
  round: number;
  at: number;
  ms: number;
  ok: boolean;
  raw: string;
};

const started = Date.now();

// One short-lived app-server per worker, which is the shape brigadier would
// actually have: N independent worker processes each asking before it spawns.
const readOnce = async (worker: number, round: number): Promise<Reading> => {
  const t0 = Date.now();
  const child = Bun.spawn(["codex", "app-server"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });

  const send = (m: unknown) => { child.stdin.write(`${JSON.stringify(m)}\n`); child.stdin.flush(); };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "brig-probe", version: "0" } } });

  let raw = "";
  let ok = false;
  const dec = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + 45_000;

  const pump = (async () => {
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buffered += dec.decode(chunk, { stream: true });
      let i = buffered.indexOf("\n");
      while (i !== -1) {
        const line = buffered.slice(0, i).trim();
        buffered = buffered.slice(i + 1);
        i = buffered.indexOf("\n");
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result !== undefined) {
          // initialize answered; now ask the question.
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });
        }
        if (msg.id === 2) {
          raw = JSON.stringify(msg.result ?? msg.error ?? null);
          ok = msg.result !== undefined;
          return;
        }
      }
      if (Date.now() > deadline) return;
    }
  })();

  await Promise.race([pump, Bun.sleep(45_000)]);
  child.kill("SIGKILL");
  await child.exited;

  return { worker, round, at: Date.now() - started, ms: Date.now() - t0, ok, raw };
};

// Canonicalise before comparing. The response carries `rateLimitsByLimitId`,
// which is a MAP — and its key order is not stable across serialisations. A
// first version of this regex-scraped every percentage in document order and
// duly reported "workers disagree" because one process emitted
// codex=51,spark=0 and another emitted spark=0,codex=51. Same reading, opposite
// verdict. Parse it, key it by limitId, and sort.
const scalars = (raw: string): string => {
  let o: any;
  try { o = JSON.parse(raw); } catch { return "(unparseable)"; }
  const byId = o?.rateLimits?.rateLimitsByLimitId ?? o?.rateLimitsByLimitId;
  const parts: string[] = [];
  if (byId && typeof byId === "object") {
    for (const id of Object.keys(byId).sort()) {
      const b = byId[id];
      const p = b?.primary ?? {};
      parts.push(`${id}=${p.usedPercent}%@${p.windowDurationMins}m/reset${p.resetsAt}`);
    }
  }
  const top = o?.rateLimits ?? o;
  if (top?.spendControlReached !== undefined) parts.push(`spendControlReached=${top.spendControlReached}`);
  if (top?.rateLimitReachedType !== undefined) parts.push(`rateLimitReachedType=${top.rateLimitReachedType}`);
  return parts.length ? parts.join(" ") : "(no rate-limit fields found)";
};

console.log(`MEASURING ${WORKERS} concurrent readers, ${ROUNDS} round(s), ${GAP}ms apart`);
const v = Bun.spawnSync(["codex", "--version"], { stdout: "pipe" });
console.log(`codex ${new TextDecoder().decode(v.stdout).trim()}`);
console.log("");

const all: Reading[] = [];
for (let round = 1; round <= ROUNDS; round++) {
  // All at once — a staggered fan-out would not test simultaneity.
  const readings = await Promise.all(
    Array.from({ length: WORKERS }, (_, i) => readOnce(i + 1, round)),
  );
  all.push(...readings);

  console.log(`--- round ${round} ---`);
  for (const r of readings.sort((a, b) => a.worker - b.worker)) {
    console.log(`  worker ${r.worker}  t+${String(r.at).padStart(6)}ms  in ${String(r.ms).padStart(5)}ms  ok=${r.ok}  ${scalars(r.raw).slice(0, 160)}`);
  }

  const shapes = new Set(readings.filter((r) => r.ok).map((r) => scalars(r.raw)));
  console.log(`  distinct readings this round: ${shapes.size} (${readings.filter((r) => r.ok).length} successful)`);
  if (shapes.size > 1) console.log("  !! workers disagree — a pre-flight read is a per-process snapshot, not shared state");

  if (round < ROUNDS) await Bun.sleep(GAP);
}

console.log("");
const okAll = all.filter((r) => r.ok);
if (!okAll.length) {
  console.log("NOTHING MEASURED — no worker got a successful reading. Not a pass.");
  process.exit(1);
}
const byRound = new Map<number, Set<string>>();
for (const r of okAll) {
  if (!byRound.has(r.round)) byRound.set(r.round, new Set());
  byRound.get(r.round)!.add(scalars(r.raw));
}
console.log("--- across rounds ---");
for (const [round, shapes] of [...byRound].sort((a, b) => a[0] - b[0])) {
  console.log(`  round ${round}: ${shapes.size} distinct reading(s)`);
  for (const s of shapes) console.log(`     ${s.slice(0, 200)}`);
}
const latencies = okAll.map((r) => r.ms).sort((a, b) => a - b);
console.log(`  read latency under concurrency: min ${latencies[0]}ms median ${latencies[latencies.length >> 1]}ms max ${latencies[latencies.length - 1]}ms`);
console.log("");
console.log("A pre-flight filter is only sound if all workers in a round agree AND the reading");
console.log("moves when work is done. Round-to-round movement here is only meaningful if something");
console.log("consumed quota in between; with no turns run, identical rounds mean 'stable', not 'stale'.");
