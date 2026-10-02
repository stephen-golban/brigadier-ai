import { create } from "zustand";

import { setPinnedSummary } from "@/state/actions";

export const useSummary = create<{
  layout: "beside" | "shift" | "float";
  floating: boolean;
}>(() => ({ layout: "beside", floating: false }));

/** Open the same card beside the thread or in the narrow window's summary. */
export function revealPlan(cardId: string): void {
  if (useSummary.getState().layout === "float")
    useSummary.setState({ floating: true });
  else setPinnedSummary(true);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const card = document.getElementById(`plan-${cardId}`);
      card?.scrollIntoView({ block: "nearest" });
      card?.focus({ preventScroll: true });
    }),
  );
}
