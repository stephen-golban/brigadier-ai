import { Lightbulb, Reload } from "@openai/apps-sdk-ui/components/Icon";
import { useEffect, useState } from "react";

import { useAction } from "@/app/conversation/useAction";
import { errorText } from "@/app/dialogs/fields";
import { PROVIDER_LABELS } from "@/app/inspector/providers/shared";
import { ProviderGlyph } from "@/components/glyphs/provider-glyphs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type {
  KeepAwake,
  ProviderKind,
  ProviderOverview,
  QuotaSnapshot,
  QuotaWindow,
} from "@/ipc/generated";
import { formatAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { loadProviders, refreshProviders } from "@/state/actions";
import {
  KEEP_AWAKE_OPTIONS,
  lidClosedHint,
  loadKeepAwake,
  setKeepAwake,
  setKeepAwakeLidClosed,
  useKeepAwake,
} from "@/state/keepAwake";
import { useApp } from "@/state/store";

const PROVIDERS: readonly ProviderKind[] = ["claude", "codex"];

/** Usage is checked again this often while Brigadier is in front… */
const USAGE_EVERY_MS = 15 * 60_000;
/** …and on coming to the front, when what it shows is older than this. */
const USAGE_STALE_MS = 5 * 60_000;
/** How often keeping awake is checked (an agent starting or finishing changes it). */
const AWAKE_EVERY_MS = 15_000;

let lastUsageRefreshMs = Date.now();

function refreshUsage(): void {
  lastUsageRefreshMs = Date.now();
  refreshProviders().catch((error: unknown) => console.error("refreshing usage failed", error));
}

/**
 * The bar along the bottom of the window: each agent's usage windows on the left (details on
 * click), keeping the computer awake on the right.
 */
export function StatusBar() {
  return (
    <footer className="bg-sidebar text-muted-foreground h-status-bar flex shrink-0 items-center gap-4 overflow-hidden border-t px-2 text-xs whitespace-nowrap select-none">
      <Usage />
      <div className="ms-auto flex shrink-0 items-center gap-3">
        <KeepAwakeMenu />
      </div>
    </footer>
  );
}

// ----- usage ---------------------------------------------------------------------------

/** Re-renders every half minute, for the countdowns. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** "now", "42m", "2h 5m", "3d 4h": the time left until `ms`. */
function countdown(ms: number, now: number): string {
  const minutes = Math.ceil((ms - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

function used(window: QuotaWindow): number {
  return Math.round(Math.min(100, Math.max(0, window.usedPercent)));
}

/** Shortest window first (the session, then the week). */
function ordered(quota: QuotaSnapshot): QuotaWindow[] {
  return quota.windows.toSorted(
    (a, b) =>
      (a.windowMinutes ?? Number.MAX_SAFE_INTEGER) - (b.windowMinutes ?? Number.MAX_SAFE_INTEGER),
  );
}

/** A window worth showing in the bar at once. */
const INLINE_FROM_PERCENT = 50;

/**
 * What the bar shows inline: the fixed-length windows (the session, the week) and any other
 * window filling up; the rest is in the details.
 */
function inline(quota: QuotaSnapshot): QuotaWindow[] {
  const windows = ordered(quota);
  const shown = windows.filter(
    (window) => window.windowMinutes !== null || used(window) >= INLINE_FROM_PERCENT,
  );
  return shown.length > 0 ? shown : windows.slice(0, 1);
}

function tone(percent: number): { text: string; fill: string } {
  if (percent >= 80) return { text: "text-destructive", fill: "bg-destructive" };
  if (percent >= 60) return { text: "text-warning", fill: "bg-warning" };
  return { text: "text-foreground", fill: "bg-muted-foreground/60" };
}

function withQuota(
  overview: ProviderOverview,
): overview is ProviderOverview & { quota: QuotaSnapshot } {
  return overview.quota !== null && overview.quota.windows.length > 0;
}

/** Loads usage, then keeps it fresh while the window is in front. */
function useUsageRefresh(): void {
  const connected = useApp((s) => s.connection.status === "connected");
  useEffect(() => {
    if (!connected) return;
    if (!useApp.getState().providers.view) {
      loadProviders().catch((error: unknown) => console.error("loading usage failed", error));
    }
    const inFront = () => document.hasFocus() && useApp.getState().windowVisible;
    const timer = window.setInterval(() => {
      if (inFront()) refreshUsage();
    }, USAGE_EVERY_MS);
    const onFocus = () => {
      const now = Date.now();
      if (now - lastUsageRefreshMs < USAGE_STALE_MS) return;
      const quotas = (useApp.getState().providers.view?.providers ?? []).flatMap((p) =>
        p.quota ? [p.quota] : [],
      );
      if (
        quotas.length === 0 ||
        quotas.some((quota) => now - quota.observedAtMs > USAGE_STALE_MS)
      ) {
        refreshUsage();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [connected]);
}

function Usage() {
  useUsageRefresh();
  const providers = useApp((s) => s.providers.view?.providers);
  const now = useNow();
  const shown = (providers ?? []).filter(withQuota);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Agent usage"
          className="hover:bg-accent/70 hover:text-foreground focus-visible:ring-ring/50 flex min-w-0 items-center gap-3 overflow-hidden rounded-xs px-1 py-0.5 outline-none focus-visible:ring-1"
        >
          {shown.length === 0 ? (
            <span>Usage</span>
          ) : (
            shown.map((overview) => (
              <UsageChip key={overview.provider} overview={overview} now={now} />
            ))
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-xs p-0">
        <UsageDetails providers={providers ?? []} now={now} />
      </PopoverContent>
    </Popover>
  );
}

function UsageChip({
  overview,
  now,
}: {
  overview: ProviderOverview & { quota: QuotaSnapshot };
  now: number;
}) {
  const windows = inline(overview.quota);
  const tightest = Math.max(...windows.map(used));
  const limit = overview.quota.limit;
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={PROVIDER_LABELS[overview.provider]}>
      <ProviderGlyph provider={overview.provider} className="size-icon-sm shrink-0" />
      {limit ? (
        <span className="text-destructive">
          Limit reached
          {limit.resetsAtMs !== null && ` · ${countdown(limit.resetsAtMs, now)}`}
        </span>
      ) : (
        <>
          <span
            aria-hidden
            className="bg-muted rounded-capsule h-1.5 w-10 shrink-0 overflow-hidden"
          >
            <span
              className={cn("block h-full", tone(tightest).fill)}
              style={{ width: `${tightest}%` }}
            />
          </span>
          {windows.map((window, index) => (
            <span key={window.id} className="flex items-center gap-1.5 tabular-nums">
              {index > 0 && <span className="text-muted-foreground/60">·</span>}
              <span className="text-foreground">{used(window)}% used</span>
              <span>
                {window.resetsAtMs !== null ? countdown(window.resetsAtMs, now) : window.label}
              </span>
            </span>
          ))}
        </>
      )}
    </span>
  );
}

function UsageDetails({ providers, now }: { providers: ProviderOverview[]; now: number }) {
  const refresh = useAction();
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="flex-1 text-sm font-medium">Usage</span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Check usage again"
          disabled={refresh.busy}
          onClick={() => refresh.run(async () => refreshUsage())}
        >
          <Reload className={refresh.busy ? "animate-spin" : undefined} />
        </Button>
      </div>
      <ul className="divide-y">
        {PROVIDERS.map((provider) => (
          <ProviderUsage
            key={provider}
            provider={provider}
            overview={providers.find((entry) => entry.provider === provider)}
            now={now}
          />
        ))}
      </ul>
      <p className="text-muted-foreground border-t px-3 py-2 text-2xs">
        Checked every 15 minutes while Brigadier is in front.
      </p>
    </div>
  );
}

function ProviderUsage({
  provider,
  overview,
  now,
}: {
  provider: ProviderKind;
  overview: ProviderOverview | undefined;
  now: number;
}) {
  const status = overview?.status;
  const quota = overview?.quota ?? null;
  const plan = status?.plan
    ? ` · ${status.plan.charAt(0).toUpperCase()}${status.plan.slice(1)}`
    : "";
  const missing = !status
    ? "Checking…"
    : !status.path
      ? "Not installed"
      : !status.loggedIn
        ? "Not signed in"
        : !quota || quota.windows.length === 0
          ? "No usage yet"
          : null;
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderGlyph provider={provider} className="size-icon-md shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm">
          {PROVIDER_LABELS[provider]}
          <span className="text-muted-foreground">{plan}</span>
        </span>
        {quota && !missing && (
          <span className="text-muted-foreground text-2xs">
            Updated {formatAgo(quota.observedAtMs, now)}
          </span>
        )}
      </div>
      {missing ? (
        <p className="text-muted-foreground text-xs">{missing}</p>
      ) : (
        quota && (
          <div className="flex flex-col gap-2.5">
            {quota.limit && (
              <p className="text-destructive text-xs">
                Limit reached
                {quota.limit.resetsAtMs !== null &&
                  ` · resets in ${countdown(quota.limit.resetsAtMs, now)}`}
              </p>
            )}
            {ordered(quota)
              // Windows the CLI reports without a known length say nothing until used.
              .filter((window) => window.windowMinutes !== null || used(window) > 0)
              .map((window) => {
                const percent = used(window);
                return (
                  <div key={window.id} className="flex flex-col gap-1">
                    <div className="flex items-baseline gap-2 text-xs">
                      <span className="flex-1">{window.label}</span>
                      <span className={cn("tabular-nums", tone(percent).text)}>
                        {percent}% used
                      </span>
                    </div>
                    <div className="bg-muted rounded-capsule h-1.5 overflow-hidden">
                      <div
                        className={cn("h-full", tone(percent).fill)}
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    {window.resetsAtMs !== null && (
                      <span className="text-muted-foreground text-2xs">
                        Resets in {countdown(window.resetsAtMs, now)}
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
        )
      )}
    </li>
  );
}

// ----- keep awake ----------------------------------------------------------------------

/** Keeps the status fresh while the window can be seen. */
function useKeepAwakeStatus(): void {
  const connected = useApp((s) => s.connection.status === "connected");
  useEffect(() => {
    if (!connected) return;
    const load = () => {
      loadKeepAwake().catch((error: unknown) => console.error("checking keep awake failed", error));
    };
    load();
    const timer = window.setInterval(() => {
      if (useApp.getState().windowVisible) load();
    }, AWAKE_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [connected]);
}

function KeepAwakeMenu() {
  useKeepAwakeStatus();
  const keepAwake = useApp((s) => s.settings.keepAwake);
  const lidClosed = useApp((s) => s.settings.keepAwakeLidClosed);
  const status = useKeepAwake((s) => s.status);
  const settingUp = useKeepAwake((s) => s.settingUp);
  const [error, setError] = useState<string | null>(null);
  const option = KEEP_AWAKE_OPTIONS.find((entry) => entry.value === keepAwake);
  const active = status?.active ?? false;
  const shownError = error ?? status?.error ?? null;

  const run = (action: () => Promise<void>) => {
    setError(null);
    action().catch((cause: unknown) => setError(errorText(cause)));
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) run(loadKeepAwake);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Keep computer awake: ${option?.label ?? ""}, ${active ? "active" : "inactive"}`}
          className="hover:bg-accent/70 hover:text-foreground focus-visible:ring-ring/50 flex items-center gap-1.5 rounded-xs px-1 py-0.5 outline-none focus-visible:ring-1"
        >
          <Lightbulb className={cn("size-icon-sm", active && "text-foreground")} />
          <span className="font-medium">{option?.label}</span>
          {status?.lidClosed === "active" && <span>· lid</span>}
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              active ? "bg-foreground" : "bg-muted-foreground/40",
              shownError && "bg-warning",
            )}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-xs">
        <DropdownMenuLabel className="flex items-center gap-2">
          <span className="flex-1">Keep computer awake</span>
          <span className="text-muted-foreground font-normal">
            {active ? "Active" : "Inactive"}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={keepAwake}
          onValueChange={(value) => run(() => setKeepAwake(value as KeepAwake))}
        >
          {KEEP_AWAKE_OPTIONS.map((entry) => (
            <DropdownMenuRadioItem key={entry.value} value={entry.value} className="rounded-surface h-auto items-start py-1.5">
              <span className="flex flex-col">
                <span>{entry.label}</span>
                <span className="text-muted-foreground text-xs">{entry.hint}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {status && status.lidClosed !== "unsupported" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={lidClosed}
              disabled={settingUp}
              className="rounded-surface h-auto items-start py-1.5"
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(on) => run(() => setKeepAwakeLidClosed(on))}
            >
              <span className="flex flex-col">
                <span>Keep going with the lid closed</span>
                <span className="text-muted-foreground text-xs">
                  {lidClosedHint(status, settingUp)}
                </span>
              </span>
            </DropdownMenuCheckboxItem>
          </>
        )}
        {shownError && (
          <p
            role="alert"
            className="text-warning flex gap-1.5 px-2 py-1.5 text-xs whitespace-normal"
          >
            {shownError}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
