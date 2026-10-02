import { create } from "zustand";

import { useBoard } from "@/state/board";

import { setPinnedSummary } from "@/state/actions";

export const useSummary = create<{
  layout: "beside" | "shift" | "float";
  floating: boolean;
}>(() => ({ layout: "beside", floating: false }));

/** Open the same card beside the thread or in the narrow window's summary. */
export function revealPlan(cardId: string): void {
  reveal(() => {
    const run = Object.values(useBoard.getState().board?.overnight ?? {}).find(
      (candidate) => candidate.state !== "superseded" && (candidate.planId === cardId || candidate.planning?.planId === cardId),
    );
    return run ? `overnight-${run.id}` : `plan-${cardId}`;
  });
}

/** Open an overnight run's card, where its Start, Stop, Merge and Continue are. */
export function revealOvernight(runId: string): void {
  reveal(() => `overnight-${runId}`);
}

function reveal(elementId: () => string): void {
  if (useSummary.getState().layout === "float")
    useSummary.setState({ floating: true });
  else setPinnedSummary(true);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const card = document.getElementById(elementId());
      card?.scrollIntoView({ block: "nearest" });
      card?.focus({ preventScroll: true });
    }),
  );
}
