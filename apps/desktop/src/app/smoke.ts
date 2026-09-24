import { request, smokeFinish } from "@/ipc/client";
import {
  frameGaps,
  ingestToPaint,
  probeSamples,
  setFrameSampling,
  summarize,
} from "@/lib/perf";
import { runProbeBurst, setInspectorOpen, setMetricsStreaming } from "@/state/actions";

const PROBES = 200;
const PROBE_INTERVAL_MS = 5;
const SETTLE_MS = 1000;
const TAIL_MS = 1200;
const BURST_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Launch smoke check (`brigadier --smoke`): measures idle RSS, fires a synthetic event burst
 * through the daemon's normal write path, times every probe from ingest to paint (painted in
 * the Inspector's event list), and hands the measurements to the shell, which evaluates the
 * §4 budgets and quits.
 */
export async function runSmoke(): Promise<void> {
  setInspectorOpen(true, "events");
  await setMetricsStreaming(true);
  await sleep(SETTLE_MS);

  const { diagnostics } = await request({ method: "getDiagnostics" });
  const idleRssBytes = diagnostics.metrics.rssBytes;

  ingestToPaint.clear();
  frameGaps.clear();
  setFrameSampling(true);

  const burst = await runProbeBurst(PROBES, PROBE_INTERVAL_MS);
  const started = performance.now();
  while (
    probeSamples(burst.burstId).length < burst.count &&
    performance.now() - started < BURST_TIMEOUT_MS
  ) {
    await sleep(50);
  }
  await sleep(TAIL_MS);

  const probes = probeSamples(burst.burstId);
  await smokeFinish({
    idleRssBytes,
    ingestToPaint: summarize(probes),
    frameGaps: summarize(frameGaps.values()),
    probesExpected: burst.count,
    probesPainted: probes.length,
  });
}
