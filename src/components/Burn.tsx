import { resetDiagnostics, getDiagnostics } from "../perfDiagnostics";
import * as store from "../feedStore";
import { getHistoryDelivery } from "../hooks/useConversationHistory";
import { Details, DetailsSummary } from "./controls/details";
import { Button } from "./controls/button";
import { Input } from "./controls/input";
/**
 * Dev-only burn panel: run N synthetic sessions at a rate through the real feed path and report
 * what the frame meter saw.
 *
 * `rows_per_sec` is **per session**, following the signature in
 * `docs/research/feed-rendering.md` §4. The summary is the gate from the same file, as revised
 * there: a run passes only when every one-second window dropped **no** vsyncs and had
 * `p95 <= 1.1 x budget` and `worst <= 3 x budget`, `budget = 1000/hz` — an average of 60 fps is
 * what you get when 59 frames run at 4 ms and one runs at a second. The single rule lives in
 * `fps.windowPasses`; this panel only renders its verdict.
 */
import { useEffect, useRef, useState } from "react";

import * as fps from "../fps";
import type { CaptureSummary } from "../fps";
import { bridge, type BurnArgs } from "../bridge";

export interface BurnProps {
  onBurn: (args: BurnArgs) => Promise<void>;
}

export function Burn({ onBurn }: BurnProps) {
  const [sessions, setSessions] = useState(10);
  const [rowsPerSec, setRowsPerSec] = useState(200);
  const [durationS, setDurationS] = useState(60);
  const [fixture, setFixture] = useState("s1-handshake-and-turn");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<CaptureSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setSummary(null);
    const idleWindow = fps.getLastReport();
    resetDiagnostics();
    fps.startCapture();
    let startedSuccessfully = false;
    const initialVisibility = { hidden: document.hidden, focused: document.hasFocus() };
    try {
      await onBurn({ sessions, rowsPerSec, durationS, fixture });
      startedSuccessfully = true;
      // The command returns as soon as the sessions are started (matching the mock's `burn`);
      // the meter is what times the run, so we wait out the run ourselves before reading it.
      await new Promise((r) => setTimeout(r, durationS * 1000 + 1200));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      const windows = fps.stopCapture();
      const result = fps.summarise(windows, durationS * 1000);
      if (result && !startedSuccessfully) result.pass = false;
      setSummary(result);
      const capture = {
        workload: { sessions, rowsPerSec, durationS, fixture },
        userAgent: navigator.userAgent,
        initialVisibility, idleWindow,
        finalVisibility: { hidden: document.hidden, focused: document.hasFocus() },
        profiling: new URLSearchParams(location.search).has("profile"),
        clockOffsetMs: Date.now() - (performance.timeOrigin + performance.now()),
        supportedEntryTypes: typeof PerformanceObserver === "undefined" ? [] : PerformanceObserver.supportedEntryTypes,
        delivery: { history: getHistoryDelivery(), ingest: store.getIngest(), sessions: Object.values(store.getState().sessions).map(s => ({ id: s.sessionId, projectId: s.projectId, rowsTotal: s.rowsTotal, rowsDropped: s.rowsDropped, lastEventSeq: s.lastEventSeq, status: s.status })) },
        diagnostics: getDiagnostics(),
        summary: result, windows,
      };
      await bridge().recordBurnCapture(capture).catch(async e => {
        setError(String(e));
        // Always retain raw frame intervals, even if diagnostic export fails.
        await bridge().recordBurnCapture({ ...capture, diagnostics: { exportError: String(e) } });
      });
      setBusy(false);
    }
  };

  // Only this explicitly enabled harness responds to the benchmark URL. A normal
  // installed build never mounts Burn; no timers or replay work run in production.
  const automatic = useRef(false);
  useEffect(() => {
    if (automatic.current || new URLSearchParams(location.search).get("burn") !== "auto") return;
    const timer = setTimeout(() => { automatic.current = true; void run(); }, 20000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <Details className="burn">
      <DetailsSummary>
        burn harness (dev) · {busy ? "running" : "idle"}
      </DetailsSummary>
      <div className="burn-form">
        <label>
          sessions
          <Input
            type="number"
            min={1}
            value={sessions}
            onChange={(e) => setSessions(Number(e.target.value))}
          />
        </label>
        <label>
          rows/s each
          <Input
            type="number"
            min={1}
            value={rowsPerSec}
            onChange={(e) => setRowsPerSec(Number(e.target.value))}
          />
        </label>
        <label>
          seconds
          <Input
            type="number"
            min={1}
            value={durationS}
            onChange={(e) => setDurationS(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="burn-form">
        <label className="grow">
          fixture
          <Input value={fixture} onChange={(e) => setFixture(e.target.value)} />
        </label>
        <Button type="button" disabled={busy} onClick={() => void run()}>
          burn
        </Button>
      </div>
      {error !== null ? <p className="burn-out bad-text">{error}</p> : null}
      {summary !== null ? (
        <p className={summary.pass ? "burn-out ok-text" : "burn-out bad-text"}>
          {summary.pass ? "PASS" : "FAIL"} · {summary.windows} windows · target{" "}
          {summary.min_hz} Hz (budget {summary.budget_ms} ms, p95 limit{" "}
          {summary.p95_limit_ms} ms) · worst window p95 {summary.worst_p95_ms}{" "}
          ms · worst frame {summary.worst_ms} ms · dropped{" "}
          {summary.total_dropped} · longest drop run {summary.longest_drop_run}{" "}
          · dom {summary.max_dom_nodes} · fixed 60 Hz target
          {summary.interrupted ? " · INVALID: window hidden during capture" : ""}
        </p>
      ) : null}
    </Details>
  );
}
