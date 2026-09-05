/**
 * What "pressing enter" means on the dock, in one place so all three modes agree.
 *
 * R2, 2026-09-05. The owner asked why there were two text fields and nothing said why. The answer
 * is `src/components/Dock.tsx`: one field, and an explicit choice of what enter does. That
 * sentence is only true if enter actually does it — so **Return submits, Shift+Return inserts a
 * newline**, and ⌘/Ctrl+Return submits as well because that is what the composer accepted before
 * this and muscle memory is cheaper to keep than to retrain.
 *
 * This changes the turn composer's old behaviour, where a bare Return inserted a newline and only
 * ⌘Return sent. Stated rather than slipped in: a multi-line goal or turn is now Shift+Return, and
 * every placeholder on the dock says so.
 *
 * `isComposing` is the one guard that is not optional. An IME (Japanese, Chinese, Korean) uses
 * Return to accept its candidate, and a handler that submits on it eats the keystroke and sends a
 * half-composed turn. `KeyboardEvent.isComposing` is the standard way to tell, and React's
 * synthetic event carries it through.
 */

/** The subset of a keyboard event this rule reads. Typed structurally so it takes React's
 *  synthetic event and a DOM one alike, and so a test can hand it a literal. */
export interface SubmitKeyEvent {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** True while an input method is mid-composition; Return then belongs to the IME. */
  nativeEvent?: { isComposing?: boolean };
}

export function isSubmitKey(e: SubmitKeyEvent): boolean {
  if (e.key !== "Enter") return false;
  if (e.nativeEvent?.isComposing === true) return false;
  // Shift+Return is the newline, always — including with a modifier held, where the intent is
  // unambiguous enough not to guess at.
  if (e.shiftKey) return false;
  return true;
}
