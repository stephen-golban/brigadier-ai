import { Button } from "./controls/button";
/**
 * The live frame meter, bottom-right. On by default in dev, behind a toggle in a release build.
 *
 * It renders once a second (when a window closes), not once a frame: the sampling is in the
 * shared rAF loop and this only reads the report it left behind.
 */
import { useSyncExternalStore } from "react";

import * as fps from "../fps";
import * as store from "../feedStore";

export function FpsOverlay() {
  const report = useSyncExternalStore(fps.subscribe, fps.getLastReport);
  const enabled = useSyncExternalStore(fps.subscribe, fps.isEnabled);
  const ingest = store.getIngest();

  if (!enabled) {
    return (
      <Button
        type="button"
        className="fps off"
        onClick={() => fps.setEnabled(true)}
      >
        fps
      </Button>
    );
  }

  // One rule, one place: `fps.windowPasses` is what the burn gate uses too.
  const bad = report !== null && !fps.windowPasses(report);

  return (
    <Button
      type="button"
      className={bad ? "fps bad" : "fps"}
      title="click to turn the meter off"
      onClick={() => fps.setEnabled(false)}
    >
      {report === null ? (
        <span>measuring…</span>
      ) : (
        <span>
          {report.hz} Hz{report.hz_source === "p50" ? " (p50)" : ""} · p50{" "}
          {report.p50_ms} · p95 {report.p95_ms} · p99 {report.p99_ms} · worst{" "}
          {report.worst_ms} ms · {report.dropped} dropped (run{" "}
          {report.longest_drop_run}) · dom {report.dom_nodes} · rows{" "}
          {ingest.rowsIn} in {ingest.batches} batches
        </span>
      )}
    </Button>
  );
}
