import { useSyncExternalStore } from "react";
import { Popover } from "./controls/overlay";
import { Button } from "@/components/ui/button";
import * as feedStore from "../feedStore";
import type { UsageWindow } from "../wire";

/**
 * The line brigadier parks below, as a fraction of a usage window.
 *
 * Not a cost control. If brigadier drinks the whole window **the owner's own Claude Code stops
 * working**, so the reserve is headroom for the human (`docs/vision.md` §6). The owner sets it;
 * `0.8` is the default that section names, and it is the line this gauge draws.
 */
export const RESERVE = 0.8;

/** The provider's window keys are an **open** set. An unknown one is shown, not dropped. */
export function windowLabel(name: string): string {
  if (name === "five_hour") return "5-hour";
  if (name === "seven_day") return "7-day";
  return name.replace(/_/g, " ");
}

/**
 * `resets_at` is **unix seconds**, unlike the milliseconds the rest of the wire uses
 * (`src/wire.ts`). `now` is milliseconds, as `Date.now()` gives it.
 */
export function resetLabel(resetsAt: number, now: number): string {
  const seconds = Math.round(resetsAt - now / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return "resetting";
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return `resets in ${days}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) return `resets in ${hours}h ${Math.floor((seconds % 3_600) / 60)}m`;
  return `resets in ${Math.max(1, Math.round(seconds / 60))}m`;
}

/** The window closest to the reserve, which is the one that decides whether work can start. */
export function tightest(windows: readonly UsageWindow[]): UsageWindow | null {
  let worst: UsageWindow | null = null;
  for (const w of windows) if (worst === null || w.utilization > worst.utilization) worst = w;
  return worst;
}

function percent(fraction: number): number {
  // Two decimals is the provider's own resolution, so 1% is the finest step that exists.
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

function Bar({ window: w }: { window: UsageWindow }) {
  const used = percent(w.utilization);
  return (
    <div className="usage-window-row">
      <span className="usage-window-name">{windowLabel(w.name)}</span>
      <span className="gauge-track" style={{ ["--gauge-mark" as string]: `${RESERVE * 100}%` }}>
        <meter
          aria-label={`${windowLabel(w.name)} window used`}
          value={used}
          min={0}
          max={100}
          low={Math.round(RESERVE * 100) - 10}
          high={Math.round(RESERVE * 100)}
          optimum={0}
        />
        <i className="gauge-mark" aria-hidden="true" />
      </span>
      <span className="usage-window-value">{used}%</span>
      <small className="usage-window-reset">{resetLabel(w.resets_at, Date.now())}</small>
    </div>
  );
}

/**
 * Where the operator stands against their own usage windows: two bars and two countdowns, with
 * the reserve line drawn on them (`docs/vision.md` §6, §12).
 *
 * **Windows, never dollars.** `UsageWindow` carries a utilization fraction and a reset epoch and
 * nothing else; `total_cost_usd` exists on the provider's wire and stops at `src/wire.ts`. No
 * currency is formatted here, and the component takes no cost input that could be.
 *
 * The snapshot comes from `feedStore.getUsageWindows`, which hands back **the same array
 * reference** until a value actually moves — that cache is why this can sit next to the composer
 * without re-rendering the transcript on every frame, and it is not to be replaced with a
 * `.map()` or a `.filter()` in the selector, which would mint a fresh array per read and make
 * `useSyncExternalStore` loop.
 */
export function UsageWindows({ sessionId }: { sessionId: string | null }) {
  const windows = useSyncExternalStore(feedStore.subscribe, () =>
    feedStore.getUsageWindows(sessionId),
  );
  const lead = tightest(windows);
  // No reading yet is not "0% used". The provider sends one per session, early but not at t=0.
  if (lead === null) return null;
  const used = percent(lead.utilization);
  const over = lead.utilization >= RESERVE;
  return (
    <Popover>
      <Button
        variant="ghost"
        size="sm"
        className="gauge-button"
        aria-label={`${windowLabel(lead.name)} usage window ${used}% spent${over ? `, past the ${Math.round(RESERVE * 100)}% reserve` : ""}`}
      >
        <span className="gauge-track" style={{ ["--gauge-mark" as string]: `${RESERVE * 100}%` }}>
          <meter
            aria-label="Usage window spent"
            value={used}
            min={0}
            max={100}
            low={Math.round(RESERVE * 100) - 10}
            high={Math.round(RESERVE * 100)}
            optimum={0}
          />
          <i className="gauge-mark" aria-hidden="true" />
        </span>
        <span>
          {windowLabel(lead.name)} {used}%
        </span>
        {over && <small className="gauge-warn">past reserve</small>}
      </Button>
      <Popover.Content placement="top end">
        <Popover.Dialog aria-label="Usage windows" className="w-72 p-3 text-sm">
          <b>Usage windows</b>
          <div className="usage-window-list">
            {windows.map(w => (
              <Bar key={w.name} window={w} />
            ))}
          </div>
          <small>
            The marked line is the {Math.round(RESERVE * 100)}% reserve — headroom kept so your own
            Claude Code keeps working, not a spending limit. Your subscription is never billed per
            token, so there is no figure in dollars to show.
          </small>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
