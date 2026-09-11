/**
 * Every Tauri event subscription in the front end goes through here, so that a **webview reload**
 * does not strand its Rust-side half.
 *
 * Tauri 2.11.5 keeps JS listeners in
 * `InnerListeners.js_event_listeners: Mutex<HashMap<WebviewLabel, HashMap<EventName, HashSet<JsHandler>>>>`
 * (`tauri-2.11.5/src/event/listener.rs:63`). Entries are added by `listen_js` (`:222-237`) and
 * removed **only** by `unlisten_js` (`:239-252`) — i.e. only when the page calls the unlisten
 * function it was handed. No navigation or page-load path drains that map, and there is no
 * `unlisten_all_js` in the crate (`docs/research/lifecycle-bounds-audit-2026-09-11.md` §2.1,
 * Gap 4). A reload destroys the document without running a single React effect cleanup, so every
 * registration the old document made survives in the Rust table for the process's life, and
 * `emit_js_filter` (`listener.rs:269-292`) evals a script for each stale id on every emit — emit
 * cost grows linearly with the number of reloads.
 *
 * The fix is entirely on this side: record each unlisten as it is handed out, and call every
 * recorded one **synchronously** from `pagehide`. `pagehide` fires for a reload, a navigation and
 * a bfcache freeze alike, and only the first two are teardowns — a frozen document is resumed
 * with its JS state intact, so draining it would hand back a page whose Rust-side subscriptions
 * are gone and which receives no events at all. `event.persisted` is the flag that tells them
 * apart (`html.spec.whatwg.org`, the `PageTransitionEvent` interface), so a persisted `pagehide`
 * drains nothing. `beforeunload` is kept as a fallback for a host that does not deliver
 * `pagehide` — it has no bfcache case, because firing it is what disqualifies a document from
 * the cache — and both are idempotent because each wrapper unlistens at most once.
 *
 * Registering again after a drain works: the drain empties the registry but never disarms it, so
 * a resume that re-subscribes is recorded like any other subscription.
 */
import {
  listen as tauriListen,
  type EventCallback,
  type EventName,
  type Options,
  type UnlistenFn,
} from "@tauri-apps/api/event";

const registered = new Set<UnlistenFn>();
let installed = false;
/** Diagnostics for the soak (`lifecycle-bounds-audit-2026-09-11.md` §6c item 1). */
const counts = { registered: 0, unlistened: 0, drains: 0 };

/**
 * Live registrations, and the totals behind them. `live` is the number the soak asserts flat
 * across a workload that includes a reload.
 */
export function listenerRegistrations() {
  return { live: registered.size, ...counts };
}

/** Synchronous on purpose: a reload gives the document no second task to run in. */
function drain(): void {
  if (registered.size === 0) return;
  counts.drains++;
  for (const off of [...registered]) off();
}

/** A bfcache freeze is not a teardown: the same document comes back, and it needs its listeners. */
function onPageHide(event: PageTransitionEvent): void {
  if (event.persisted) return;
  drain();
}

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("beforeunload", drain);
}

/**
 * `listen` from `@tauri-apps/api/event`, with the unlisten recorded until it is called.
 *
 * The returned unlisten is idempotent — a caller that unlistens after a `pagehide` drain (the
 * ordinary case for a React cleanup that loses the race with a reload) is a no-op rather than a
 * second `unlisten_js` for an id the Rust table no longer holds.
 */
export async function listen<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  install();
  const off = await tauriListen<T>(event, handler, options);
  let done = false;
  const wrapped: UnlistenFn = () => {
    if (done) return;
    done = true;
    registered.delete(wrapped);
    counts.unlistened++;
    off();
  };
  registered.add(wrapped);
  counts.registered++;
  return wrapped;
}

/** Test hook: the drain a reload would run. Never called by the app. */
export function drainListenersForTest(): void {
  drain();
}
