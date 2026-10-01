/**
 * Startup waits for the agent CLIs: the startup screen stays until each one has finished its
 * login check and, when signed in, reported its model list (the saved one or a live one) or
 * failed to. A missing or signed-out CLI doesn't hold it up, and nothing holds it for longer
 * than `AGENTS_WAIT_MS` once the app has drawn underneath; after that the app's own "checking"
 * states take over.
 */
import { PROVIDER_LABELS } from "@/app/inspector/providers/shared";
import type { ProviderOverview } from "@/ipc/generated";
import { setSplashStatus } from "@/lib/splash";
import { loadProviders } from "@/state/actions";
import { useApp } from "@/state/store";

/** The longest the startup screen waits for the agent CLIs. */
const AGENTS_WAIT_MS = 3_000;
/** A short wait says nothing; a longer one says what it is waiting for. */
const STATUS_AFTER_MS = 600;
/** The providers are read again this often while waiting, so a check that finished before
 * they were first loaded is not missed. */
const RELOAD_MS = 500;

/** Whether an agent CLI has said all startup needs: installed and signed in or not, and if so
 * its models. */
export function agentReady(overview: ProviderOverview): boolean {
  const status = overview.status;
  if (!status) return false;
  if (!status.path || !status.loggedIn) return true;
  return overview.models !== null || overview.error !== null;
}

/** "Starting Claude Code…", "Starting Claude Code and Codex…". */
function waitingFor(pending: readonly ProviderOverview[]): string {
  const names = pending.map((overview) => PROVIDER_LABELS[overview.provider]);
  const last = names.pop();
  return `Starting ${names.length > 0 ? `${names.join(", ")} and ${last}` : last}…`;
}

function reload(): void {
  void loadProviders().catch((error: unknown) => {
    console.error("loading providers failed", error);
  });
}

/** Resolves once every agent CLI is ready, or after `AGENTS_WAIT_MS`. */
export function waitForAgents(): Promise<void> {
  return new Promise((resolve) => {
    let saying = false;
    const check = () => {
      const view = useApp.getState().providers.view;
      if (!view) return;
      const pending = view.providers.filter((overview) => !agentReady(overview));
      if (pending.length === 0) done();
      else if (saying) setSplashStatus(waitingFor(pending));
    };
    const unsubscribe = useApp.subscribe((state, previous) => {
      if (state.providers.view !== previous.providers.view) check();
    });
    const reloading = setInterval(reload, RELOAD_MS);
    const status = setTimeout(() => {
      saying = true;
      check();
    }, STATUS_AFTER_MS);
    const cap = setTimeout(done, AGENTS_WAIT_MS);
    function done() {
      unsubscribe();
      clearInterval(reloading);
      clearTimeout(status);
      clearTimeout(cap);
      resolve();
    }
    reload();
    check();
  });
}
