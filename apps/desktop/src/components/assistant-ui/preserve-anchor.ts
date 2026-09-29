/** How long a toggle is held in place: the longest fold animation, with a frame to spare. */
const HOLD_MS = 350;

/**
 * Keeps a toggle (a fold's header) where it is on screen while what it opens or closes grows
 * or shrinks, above it or below: the thread scrolls by however far the toggle moved, on every
 * resize of its turn and on the next frame. It lets go after the animation, or as soon as the
 * user scrolls, clicks or types in the thread. Call it before the fold changes.
 */
export function preserveAnchor(toggle: HTMLElement): void {
  const scroller = toggle.closest<HTMLElement>('[data-slot="aui_thread-viewport"]');
  if (!scroller) return;
  const top = toggle.getBoundingClientRect().top;
  let frame: number | null = null;
  // The thread's scroll offset grows toward its bottom whichever way it lays out, so moving
  // it by how far the toggle moved puts the toggle back.
  const fix = () => {
    if (toggle.isConnected) scroller.scrollTop += toggle.getBoundingClientRect().top - top;
  };
  const nextFrame = () => {
    frame ??= window.requestAnimationFrame(() => {
      frame = null;
      fix();
    });
  };
  const resized = () => {
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
    fix();
    nextFrame();
  };
  const turn = toggle.closest('[data-slot="aui_assistant-message-root"]');
  const observer = turn && typeof ResizeObserver !== "undefined" ? new ResizeObserver(resized) : null;
  if (turn) observer?.observe(turn);
  nextFrame();

  const listening = new AbortController();
  const stop = () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    observer?.disconnect();
    window.clearTimeout(timer);
    listening.abort();
  };
  const timer = window.setTimeout(stop, HOLD_MS);
  for (const type of ["wheel", "touchmove", "pointerdown", "keydown"]) {
    scroller.addEventListener(type, stop, { passive: true, signal: listening.signal });
  }
}
