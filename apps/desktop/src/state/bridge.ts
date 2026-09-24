import { subscribe } from "@/ipc/client";
import type { BridgeEvent, EventEnvelope } from "@/ipc/generated";
import { markApplied, setSamplingPaused } from "@/lib/perf";
import { loadCatalog, loadMessages } from "@/state/actions";
import { applyEvents, useApp } from "@/state/store";

let queued: EventEnvelope[] = [];
let flushScheduled = false;

/** Events arrive one message at a time; everything that arrived in the same task is applied
 * in a single state update, then timed to the paint that shows it. */
function flush() {
  flushScheduled = false;
  const batch = queued;
  queued = [];
  applyEvents(batch);
  for (const { atMs, event } of batch) {
    markApplied(atMs, event.type === "probe" ? event.burstId : null);
  }
}

/** Reloads everything the UI holds: used after (re)connecting and after missing events.
 * Threads other than the open one may be stale, so they are dropped and reload when opened. */
async function resync() {
  const { selection, threads } = useApp.getState();
  const openId = selection.type === "conversation" ? selection.id : null;
  const open = openId ? threads[openId] : undefined;
  useApp.setState({ threads: openId && open ? { [openId]: open } : {} });
  await loadCatalog();
  if (openId) await loadMessages(openId);
}

function onBridgeEvent(message: BridgeEvent) {
  switch (message.type) {
    case "event":
      queued.push(message.event);
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
      }
      break;
    case "connected":
      useApp.setState({
        connection: { status: "connected", daemon: message.daemon, reason: null },
      });
      void resync().catch((error: unknown) => {
        console.error("resync after connecting failed", error);
      });
      break;
    case "disconnected":
      useApp.setState((state) => ({
        connection: {
          status: "disconnected",
          daemon: state.connection.daemon,
          reason: message.reason,
        },
      }));
      break;
    case "lagged":
      void resync().catch((error: unknown) => {
        console.error("resync after lag failed", error);
      });
      break;
    case "metrics":
      useApp.setState((state) => ({
        inspector: { ...state.inspector, metrics: message.metrics },
      }));
      break;
    case "windowVisibility":
      setSamplingPaused(!message.visible);
      useApp.setState({ windowVisible: message.visible });
      break;
  }
}

export function startBridge(): Promise<void> {
  return subscribe(onBridgeEvent);
}
