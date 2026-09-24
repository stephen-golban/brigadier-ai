/**
 * Shared surface classes for the assistant-ui elements (https://www.assistant-ui.com/elements),
 * rewritten onto Brigadier's tokens: dark only, density-driven sizes, no raw values.
 */

/** A raised card: task, approval, question and plan cards, the queue's running row. */
export const paper = "bg-card border border-border";

/** A recessed field inside a card: commands, queued rows, segmented controls. */
export const field = "bg-foreground/5";

export const fieldInteractive = "bg-foreground/5 transition-colors hover:bg-foreground/10";

/** A quiet round icon button. */
export const ghostButton =
  "text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:ring-ring/50 inline-flex shrink-0 items-center justify-center rounded-capsule outline-none transition-colors focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50";

/** Small monospace meta text (ids, counts, models). */
export const mono = "font-mono text-2xs tracking-tight";

/** Something live (running, streaming). */
export const live = "text-success";

/** A floating menu anchored to the composer (mentions). */
export const floatingMenu = "bg-popover text-popover-foreground rounded-surface border p-1";
