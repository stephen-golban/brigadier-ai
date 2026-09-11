/**
 * Who owns a keystroke while an approval is on screen.
 *
 * `ApprovalRequest` installs a **document-level** Enter/Escape handler, and so does the peek
 * sidebar (`src/components/controls/sidebar.tsx`). Both listeners fire for the same Escape, in
 * registration order, and registration order here is mount order — not something either side
 * controls. `event.defaultPrevented` is therefore not a reliable arbiter: whichever listener
 * runs first sees `false`.
 *
 * So the rule is stated once, here, and both sides read it: **while a pending approval can
 * answer this keystroke, the approval wins and every other document-level handler stands
 * down.** Nothing else changes — with no answerable approval on screen this returns `false` and
 * the sidebar's Escape behaves exactly as it did.
 *
 * This is an arbitration predicate, not an approval decision. It never resolves a request, and
 * the non-optimistic rule (`docs/vision.md` §9) is untouched: the card still clears only on
 * `request-resolved`.
 */

/**
 * Focus contexts an approval hotkey must not fire from. A keystroke inside the Lexical composer
 * — which is both `contenteditable` and `role="textbox"` — belongs to the composer, and an
 * Escape inside a dialog or a menu belongs to that surface.
 */
export const approvalHotkeyExemptSelector =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="menu"]';

/**
 * A pending approval surface that is live, not busy, and not opted out of hotkeys. Mirrors the
 * query `ApprovalRequest` uses to pick the topmost surface, plus `aria-busy`, which the card
 * sets while a decision is in flight.
 */
const answerableSurface =
  '[data-thread-approval-surface][data-decision="pending"]:not([data-hotkeys-disabled]):not([aria-busy="true"])';

/**
 * True when a pending approval card will answer this keystroke, so nothing else should.
 *
 * Deliberately **not** `event.defaultPrevented`: both handlers sit on `document`, so whichever
 * runs first sees `false`, and other surfaces prevent Escape's default for reasons that have
 * nothing to do with approvals. Presence of an answerable card is the only reliable signal.
 */
export function approvalOwnsKey(event: KeyboardEvent): boolean {
  if (typeof document === "undefined") return false;
  if (document.querySelector(answerableSurface) === null) return false;
  const target = event.target instanceof Element ? event.target : null;
  return target?.closest(approvalHotkeyExemptSelector) == null;
}
