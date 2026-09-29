/*
 * The thread's scrolling. The scroll element lays its content out bottom-up
 * (`flex-direction: column-reverse`), so the browser keeps the bottom still: `scrollTop` is 0 at
 * the end and negative above it, and everything here works in the distance from the bottom.
 * Content growing above the view moves nothing; content growing in or below it would push the
 * view up, so the distance grows by as much to keep what the user reads in place.
 *
 * The composer floats over the bottom of the thread. Its height, plus a small gap, is the
 * thread's bottom padding (`--thread-scroll-padding-bottom`), kept by a sticky pad after the
 * content.
 *
 * When the user sends a message, room is made under it for the answer (the spacer): the new turn
 * rises to the upper third of the view and the answer fills the room below it, so the view
 * stays still while it streams. A session's turn, whose work steps come before the answer,
 * starts following the work once it reaches the composer (the follow modes below).
 */

/** Within this of the bottom, the thread counts as at the bottom. */
export const AT_BOTTOM_PX = 24;
/** The scroll-to-bottom glide. */
const SCROLL_TO_BOTTOM_MS = 260;
/** How long a wheel, key, touch or scrollbar gesture makes the scrolls after it the user's. */
const INTENT_WINDOW_MS = 1000;
/** A touch moves this far before its direction counts. */
const TOUCH_SLOP_PX = 8;
/** The bottom padding is the composer's height plus this. */
const FOOTER_GAP_PX = 16;
/** The room made for an answer: two thirds of the view, and at least this much less than it. */
const SPACER_SHARE = 2 / 3;
const SPACER_MARGIN_PX = 240;
/** A message sent from further up than this (past the room) leaves the view where it is. */
const PLACE_WITHIN_PX = 300;
/** A new turn settles 1px above the end: reaching the end itself takes the room away. */
const PLACED_DISTANCE_PX = 1;
/** A trim or a change smaller than this is not worth a jump. */
const SPACER_SLACK_PX = 24;
/** The rise of a new turn: a critically damped spring that settles in about half a second. */
const SPRING_OMEGA = 18.5;
const SPRING_MS = 500;

export type TurnPhase = "idle" | "prework" | "final_answer";
export type ScrollMode = "chat" | "session";
type Direction = "away" | "toward";
type Source = "system" | "user";

export function distanceFromBottom(element: HTMLElement): number {
  return Math.max(0, -element.scrollTop);
}

function setDistanceFromBottom(element: HTMLElement, px: number): void {
  const distance = Math.max(0, px);
  element.scrollTop = distance === 0 ? 0 : -distance;
}

function distanceFromTop(element: HTMLElement): number {
  return element.scrollHeight - element.clientHeight - distanceFromBottom(element);
}

/** The thread's bottom padding: the composer's height and the gap above it. */
export function scrollPaddingBottom(element: HTMLElement): number {
  const px = Number.parseFloat(element.style.getPropertyValue("--thread-scroll-padding-bottom"));
  return Number.isFinite(px) ? px : 0;
}

/** The room made for an answer in a view of this size. */
function spacerTarget(element: HTMLElement): number {
  const visible = Math.max(0, element.clientHeight - scrollPaddingBottom(element));
  return Math.max(0, Math.min(visible * SPACER_SHARE, visible - SPACER_MARGIN_PX));
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Which way a key scrolls the thread, if it does and the thread gets it. */
function keyDirection(event: KeyboardEvent, scroller: HTMLElement): Direction | null {
  if (event.defaultPrevented || event.repeat) return null;
  const { target } = event;
  if (
    target instanceof HTMLElement &&
    target !== scroller &&
    (target.isContentEditable ||
      target.closest("input, select, textarea") !== null ||
      (event.key === " " && target.closest("button, [role=button]") !== null))
  ) {
    return null;
  }
  switch (event.key) {
    case "ArrowUp":
    case "Home":
    case "PageUp":
      return "away";
    case "ArrowDown":
    case "End":
    case "PageDown":
      return "toward";
    case " ":
      return event.shiftKey ? "away" : "toward";
    default:
      return null;
  }
}

/** A number animated on a critically damped spring, frame by frame. */
class Spring {
  value = 0;
  private frame: number | null = null;
  constructor(private readonly onChange: (value: number) => void) {}

  get animating(): boolean {
    return this.frame !== null;
  }

  set(value: number): void {
    this.stop();
    this.value = value;
    this.onChange(value);
  }

  stop(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  animateTo(target: number): void {
    this.stop();
    const from = this.value;
    if (from === target) return;
    if (reducedMotion()) {
      this.set(target);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / SPRING_MS);
      const seconds = t * (SPRING_MS / 1000);
      const settled = t >= 1;
      this.value = settled
        ? target
        : target + (from - target) * (1 + SPRING_OMEGA * seconds) * Math.exp(-SPRING_OMEGA * seconds);
      this.onChange(this.value);
      this.frame = settled ? null : requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }
}

/**
 * The scroll element's controller: where the thread is (the distance from the bottom), whether
 * it follows new content, what the user's own gestures did, the composer's padding, and the
 * scroll-to-bottom glide.
 */
export class ThreadScroller {
  element: HTMLElement | null = null;
  private lastDistance = 0;
  /** New content at the end is followed (the thread stays on its end). */
  private follow = true;
  private intent: { direction: Direction; atMs: number } | null = null;
  private glide: number | null = null;
  /** The last instant scroll: asked-for px and where the browser put it (device-pixel rounding). */
  private rounded: { requested: number; actual: number } | null = null;
  private footerHeight: number | null = null;
  private footerPreserveDisabled = false;
  private readonly scrollListeners = new Set<(distance: number) => void>();
  private readonly userScrollListeners = new Set<(distance: number, previous: number) => void>();
  private readonly changeListeners = new Set<() => void>();
  /** The room under the newest turn, which is nothing to scroll to. */
  spacerHeight: () => number = () => 0;
  /** The newest turn's layout, while the thread is laid out. */
  private turns: TurnLayout | null = null;

  setTurns(turns: TurnLayout | null): void {
    this.turns = turns;
  }

  /** The scroll button: through the newest turn's layout, which knows about the room. */
  scrollToEnd = (): void => {
    if (this.turns) this.turns.scrollToBottom();
    else this.scrollToBottom();
  };

  /** The user sent a message. */
  sent = (): void => this.turns?.sent();

  get animating(): boolean {
    return this.glide !== null;
  }

  get following(): boolean {
    return this.follow;
  }

  get distance(): number {
    return this.lastDistance;
  }

  /** Whether part of the thread lies below what shows, not counting the room for an answer. */
  contentBelow = (): boolean => this.lastDistance > this.spacerHeight() + AT_BOTTOM_PX;

  subscribe = (listener: () => void): (() => void) => {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  };

  addScrollListener(listener: (distance: number) => void): () => void {
    this.scrollListeners.add(listener);
    return () => this.scrollListeners.delete(listener);
  }

  addUserScrollListener(listener: (distance: number, previous: number) => void): () => void {
    this.userScrollListeners.add(listener);
    return () => this.userScrollListeners.delete(listener);
  }

  /** Tells the subscribers something that decides the scroll button changed. */
  changed(): void {
    for (const listener of this.changeListeners) listener();
  }

  /** The distance the last instant scroll asked for, when the browser rounded it to `actual`. */
  unrounded(actual: number): number {
    return this.rounded?.actual === actual ? this.rounded.requested : actual;
  }

  private onDistance(distance: number): void {
    if (this.rounded?.actual !== distance) this.rounded = null;
    this.lastDistance = distance;
    for (const listener of this.scrollListeners) listener(distance);
    this.changed();
  }

  private stopGlide(): void {
    if (this.glide !== null) cancelAnimationFrame(this.glide);
    this.glide = null;
  }

  private onUserScroll(distance: number, previous: number): void {
    this.follow = distance < previous && distance <= AT_BOTTOM_PX;
    for (const listener of this.userScrollListeners) listener(distance, previous);
  }

  private apply(behavior: ScrollBehavior, distance: number): void {
    const element = this.element;
    if (!element) return;
    const target = Math.max(0, distance);
    element.scrollTo({ top: target === 0 ? 0 : -target, behavior });
    const actual = distanceFromBottom(element);
    this.rounded =
      behavior === "instant" &&
      actual !== target &&
      target > 0 &&
      target < element.scrollHeight - element.clientHeight
        ? { requested: target, actual }
        : null;
    this.onDistance(actual);
  }

  /** Puts the thread `px` from its end; 0 follows new content again. */
  scrollToDistance(px: number, source: Source = "system"): void {
    const previous = this.lastDistance;
    const target = Math.max(0, px);
    if (target > AT_BOTTOM_PX) this.stopGlide();
    if (target === 0) this.follow = true;
    this.apply("instant", target);
    if (source === "user" && this.lastDistance !== previous) this.onUserScroll(this.lastDistance, previous);
  }

  /** Keeps the view on what it shows while content changes size, unless the thread glides. */
  compensate(px: number): void {
    if (!this.animating) this.apply("instant", px);
  }

  /** Stops following and gliding: the view stays where it is. */
  hold(): void {
    this.stopGlide();
    this.follow = false;
  }

  /** While a turn works in place, the composer changing size doesn't move the view with it. */
  setFooterPreserveDisabled(disabled: boolean): void {
    this.footerPreserveDisabled = disabled;
  }

  /** Glides to the end (260ms, easing out), or jumps there when it is close or motion is reduced. */
  scrollToBottom = (): void => {
    const element = this.element;
    if (!element) return;
    this.follow = true;
    const start = distanceFromBottom(element);
    if (reducedMotion() || start <= AT_BOTTOM_PX) {
      this.stopGlide();
      this.apply("instant", 0);
      return;
    }
    this.stopGlide();
    this.intent = null;
    this.rounded = null;
    const begun = performance.now();
    const step = (now: number) => {
      const current = this.element;
      if (!current) {
        this.glide = null;
        return;
      }
      const progress = Math.min(1, (now - begun) / SCROLL_TO_BOTTOM_MS);
      const eased = 1 - (1 - progress) ** 3;
      setDistanceFromBottom(current, start * (1 - eased));
      if (progress < 1 && distanceFromBottom(current) > AT_BOTTOM_PX) {
        this.glide = requestAnimationFrame(step);
        return;
      }
      this.glide = null;
      this.apply("instant", 0);
    };
    this.glide = requestAnimationFrame(step);
  };

  /** The composer's new height: the padding follows it, and a scrolled-up view stays still. */
  footerResized(height: number): void {
    const element = this.element;
    if (!element) return;
    element.style.setProperty("--thread-scroll-padding-bottom", `${height + FOOTER_GAP_PX}px`);
    const previous = this.footerHeight;
    this.footerHeight = height;
    if (previous === null || previous === height || this.animating || this.footerPreserveDisabled) return;
    // At the end the pad grows with the composer and the content rides up with it.
    if (distanceFromBottom(element) <= AT_BOTTOM_PX) return;
    this.apply("instant", distanceFromBottom(element) + height - previous);
  }

  /** Listens to the scroll element: the user's gestures, and every scroll. */
  attach(element: HTMLElement): () => void {
    this.element = element;
    const controller = new AbortController();
    const options = { passive: true, signal: controller.signal };
    let touch: Touch | null = null;
    let drag: { scrollHeight: number; scrollTop: number } | null = null;

    const registerIntent = (direction: Direction) => {
      this.stopGlide();
      this.rounded = null;
      const canMove =
        direction === "away" ? distanceFromTop(element) > 0 : distanceFromBottom(element) > 0;
      this.intent = canMove ? { direction, atMs: performance.now() } : null;
    };
    const notify = () => {
      const distance = distanceFromBottom(element);
      if (distance <= AT_BOTTOM_PX) this.stopGlide();
      this.onDistance(distance);
    };
    const onScroll = () => {
      const previous = this.lastDistance;
      // A scroll with the content's height unchanged after a press on the scrollbar is a drag.
      if (drag) {
        const { scrollHeight, scrollTop } = drag;
        drag = null;
        const distance = distanceFromBottom(element);
        if (
          element.scrollHeight === scrollHeight &&
          element.scrollTop !== scrollTop &&
          distance !== previous
        ) {
          this.intent = { direction: distance > previous ? "away" : "toward", atMs: performance.now() };
        }
      }
      const intent = this.intent;
      if (!intent) return notify();
      const now = performance.now();
      if (now - intent.atMs > INTENT_WINDOW_MS) {
        this.intent = null;
        return notify();
      }
      notify();
      const distance = distanceFromBottom(element);
      const direction = distance > previous ? "away" : distance < previous ? "toward" : null;
      if (direction !== intent.direction) return;
      intent.atMs = now;
      this.onUserScroll(distance, previous);
      if (distance <= AT_BOTTOM_PX) this.intent = null;
    };
    element.addEventListener("scroll", onScroll, options);
    element.addEventListener(
      "wheel",
      (event) => {
        if (event.deltaY !== 0) registerIntent(event.deltaY < 0 ? "away" : "toward");
      },
      options,
    );
    element.addEventListener(
      "keydown",
      (event) => {
        const direction = keyDirection(event, element);
        if (direction) registerIntent(direction);
      },
      options,
    );
    element.addEventListener(
      "pointerdown",
      (event) => {
        drag = null;
        this.intent = null;
        if (event.pointerType === "mouse" && event.target === element) {
          this.stopGlide();
          this.rounded = null;
          drag = { scrollHeight: element.scrollHeight, scrollTop: element.scrollTop };
        }
      },
      options,
    );
    const endDrag = () => {
      drag = null;
    };
    element.addEventListener("pointerup", endDrag, options);
    element.addEventListener("pointercancel", endDrag, options);
    element.addEventListener(
      "touchstart",
      (event) => {
        touch = event.touches.length === 1 ? (event.touches[0] ?? null) : null;
      },
      options,
    );
    element.addEventListener(
      "touchmove",
      (event) => {
        const moved = event.touches.length === 1 ? event.touches[0] : undefined;
        if (!touch || !moved || moved.identifier !== touch.identifier) {
          touch = null;
          return;
        }
        const dx = moved.clientX - touch.clientX;
        const dy = moved.clientY - touch.clientY;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < TOUCH_SLOP_PX) return;
        touch = null;
        if (Math.abs(dy) > Math.abs(dx)) registerIntent(dy > 0 ? "away" : "toward");
      },
      options,
    );
    const endTouch = () => {
      touch = null;
    };
    element.addEventListener("touchend", endTouch, options);
    element.addEventListener("touchcancel", endTouch, options);
    notify();
    return () => {
      controller.abort();
      this.stopGlide();
      if (this.element === element) this.element = null;
    };
  }
}

/* ----- the newest turn: the room for its answer, its rise, and the follow modes ----------- */

/**
 * How a session's turn is followed while it works:
 * - `static`: the view stays put; the answer grows below what shows.
 * - `prework_watch`: steps run; the view stays put until they reach the composer.
 * - `prework_follow`: the steps reached the composer; the view follows them.
 * - `user_follow`: the view follows the turn (the user went to the end, or followed steps
 *   turned into the answer).
 */
export type FollowMode = "static" | "prework_watch" | "prework_follow" | "user_follow";

type FollowEvent =
  | { type: "placed" | "removed" }
  | { type: "phase_changed"; previous: TurnPhase; phase: TurnPhase }
  | { type: "follow_content_changed"; overflowPx: number; phase: TurnPhase }
  | { type: "scroll_distance_changed"; distance: number; phase: TurnPhase }
  | { type: "scroll_to_bottom"; phase: TurnPhase };

export function nextFollowMode(mode: FollowMode, event: FollowEvent): FollowMode {
  switch (event.type) {
    case "placed":
    case "removed":
      return "static";
    case "follow_content_changed":
      return event.phase === "prework" && mode === "prework_watch" && event.overflowPx > 0
        ? "prework_follow"
        : mode;
    case "phase_changed": {
      const { previous, phase } = event;
      let next = mode;
      if (previous !== "prework" && phase === "prework") {
        if (next === "static") next = "prework_watch";
        else if (next === "user_follow") next = "prework_follow";
      }
      if (previous === "prework" && phase === "final_answer") {
        next = next === "prework_follow" ? "user_follow" : "static";
      }
      if (previous !== "idle" && phase === "idle" && next !== "user_follow") next = "static";
      return next;
    }
    case "scroll_distance_changed":
      if (event.distance <= AT_BOTTOM_PX) return mode;
      if (mode === "prework_follow") return "prework_watch";
      if (mode === "user_follow") return event.phase === "prework" ? "prework_watch" : "static";
      return mode;
    case "scroll_to_bottom":
      return event.phase === "prework" ? "prework_follow" : "user_follow";
  }
}

const preserving = (mode: FollowMode) => mode === "static" || mode === "prework_watch";

/** What the thread keeps of a conversation's scroll while it is not shown. */
type Saved = { distance: number; mode: FollowMode; turnKey: string | null };
const saved = new Map<string, Saved>();

type Turn = { key: string | null; phase: TurnPhase; live: boolean };

/** Where the user sent from, and whether their new turn is placed or the view is kept. */
type Placement = { distance: number; scrollHeight: number; place: boolean };

/** How long after a new turn shows its send may still place it. */
const LATE_SEND_MS = 1000;

/**
 * The rows of the message list, the room after them and the newest turn. Rows are the list's
 * children; the newest turn is the last user message and everything after it, and its
 * `data-turn-*` attributes say how far it got.
 */
export class TurnLayout {
  private readonly spacer: Spring;
  private readonly rise: Spring;
  private rows: HTMLElement[] = [];
  private readonly heights = new WeakMap<Element, number>();
  private turn: Turn = { key: null, phase: "idle", live: false };
  private mode: FollowMode = "static";
  /** Where the user sent from: whether their new turn is placed, or the view kept. */
  private pending: Placement | null = null;
  /**
   * A new turn that showed before the user's send was heard (the message is shown first, then
   * the send is reported): the send places it, if it comes soon after.
   */
  private unplaced: { key: string; atMs: number; distance: number; scrollHeight: number } | null =
    null;
  /** The spring's target while the room opens. */
  private opening = 0;
  /** The room is out of view (behind the composer or below). */
  private spacerHidden = false;
  /** Scroll the user away from the end has not yet taken out of the room (chat). */
  private consumePending = 0;
  private consumeFrame: number | null = null;
  private restoring: number | null = null;
  private placedOnce = false;

  constructor(
    private readonly scroller: ThreadScroller,
    private readonly scrollMode: ScrollMode,
    private readonly group: HTMLElement,
    private readonly spacerElement: HTMLElement,
    private readonly saveKey: string | null,
  ) {
    this.spacer = new Spring((value) => {
      spacerElement.style.height = `${value}px`;
      scroller.changed();
    });
    this.rise = new Spring((value) => this.applyRise(value));
    scroller.spacerHeight = () => this.spacer.value;
  }

  private get element(): HTMLElement | null {
    return this.scroller.element;
  }

  private get session(): boolean {
    return this.scrollMode === "session";
  }

  /* --- the newest turn, read from the rows ------------------------------------------------ */

  private readTurn(): Turn {
    const rows = this.rows;
    let userIndex = -1;
    for (let index = rows.length - 1; index >= 0; index--) {
      if (rows[index]?.dataset["role"] === "user") {
        userIndex = index;
        break;
      }
    }
    const last = rows[rows.length - 1];
    const answer = userIndex >= 0 && userIndex < rows.length - 1 ? last : undefined;
    const user = userIndex >= 0 ? rows[userIndex] : undefined;
    const key = user?.dataset["messageId"]
      ? `${user.dataset["messageId"]}:${answer?.dataset["turnSteers"] ?? "0"}`
      : null;
    const phase = (answer?.dataset["turnPhase"] as TurnPhase | undefined) ?? "idle";
    const live = answer?.dataset["turnLive"] === "true";
    return { key, phase: live ? phase : "idle", live };
  }

  private turnRows(): HTMLElement[] {
    for (let index = this.rows.length - 1; index >= 0; index--) {
      if (this.rows[index]?.dataset["role"] === "user") return this.rows.slice(index);
    }
    return [];
  }

  private applyRise(value: number): void {
    const transform = value === 0 ? "" : `translateY(${value}px)`;
    for (const row of this.turnRows()) row.style.transform = transform;
  }

  /* --- the room for the answer ------------------------------------------------------------ */

  private setSpacer(value: number): void {
    this.spacer.set(Math.max(0, value));
  }

  /** Takes the room away at once, the view staying on the same content. */
  private clearSpacer(compensate: boolean): void {
    const old = this.spacer.value;
    this.spacer.stop();
    this.spacerHidden = false;
    this.consumePending = 0;
    if (old === 0) return;
    this.setSpacer(0);
    if (compensate) this.scroller.compensate(Math.max(0, this.scroller.distance - old));
  }

  /** Leaves only `visible` of the room (a session's, once scrolled past or the turn ended). */
  private trimSpacer(visible: number): void {
    const current = this.spacer.value;
    const next = visible <= SPACER_SLACK_PX ? 0 : Math.min(current, visible);
    if (current - next <= SPACER_SLACK_PX) return;
    this.rise.set(0);
    this.setSpacer(next);
    this.scroller.scrollToDistance(Math.max(0, this.scroller.distance + next - current));
  }

  /**
   * A chat's newest turn grew by `delta` (and the rows kept in view by `anchored`, which counts
   * it): the answer fills its room, which shrinks by as much, and nothing moves.
   */
  private growIntoSpacer(delta: number, anchored: number): void {
    const element = this.element;
    if (!element) return;
    const distance = this.scroller.unrounded(distanceFromBottom(element));
    const old = this.spacer.value;
    const next = Math.max(0, old - delta);
    this.setSpacer(next);
    this.scroller.compensate(Math.max(0, distance + anchored + next - old));
    this.checkSpacerVisible();
  }

  /** The user's scroll away from the end takes `px` out of a chat's room. */
  private consume(px: number): void {
    if (px <= 0) return;
    const old = this.spacer.value;
    const next = Math.max(0, old - px);
    if (next === old) return;
    const distance = this.scroller.distance;
    this.setSpacer(next);
    this.scroller.compensate(Math.max(0, distance - (old - next)));
    this.checkSpacerVisible();
  }

  /** Chat: once all the room lies behind the composer, it is taken away. */
  private checkSpacerVisible(): void {
    const element = this.element;
    const old = this.spacer.value;
    if (!element || old <= 0) return;
    const box = element.getBoundingClientRect();
    const scale = box.height / element.clientHeight || 1;
    const composerTop = box.bottom - scrollPaddingBottom(element) * scale;
    if (this.spacerElement.getBoundingClientRect().top < composerTop - scale) return;
    this.setSpacer(0);
    this.scroller.compensate(Math.max(0, this.scroller.distance - old));
  }

  /** The view changed size: the room never grows, and shrinks to what now fits. */
  resized(): void {
    const element = this.element;
    if (!element || element.clientHeight <= 0) return;
    const target = spacerTarget(element);
    const current = this.spacer.value;
    if (this.session) {
      if (this.spacer.animating && this.opening > target) {
        this.opening = target;
        if (current <= target) {
          this.spacer.animateTo(target);
          return;
        }
        this.spacer.stop();
      }
      const next = Math.min(current, target);
      if (Math.abs(next - current) <= SPACER_SLACK_PX) return;
      this.setSpacer(next);
      this.scroller.scrollToDistance(Math.max(0, this.scroller.distance + next - current));
      return;
    }
    if (current <= 0) return;
    const next = Math.min(current, target);
    if (next === current) return;
    this.setSpacer(next);
    this.scroller.compensate(Math.max(0, this.scroller.distance - (current - next)));
  }

  /* --- sending and placing ---------------------------------------------------------------- */

  /** The user sent a message: remembers where from, for placing the turn it starts. */
  sent(): void {
    const element = this.element;
    if (!element) return;
    const unplaced = this.unplaced;
    this.unplaced = null;
    if (
      unplaced &&
      unplaced.key === this.turn.key &&
      performance.now() - unplaced.atMs < LATE_SEND_MS
    ) {
      this.applyPlacement(this.placement(unplaced.distance, unplaced.scrollHeight));
      return;
    }
    this.pending = this.placement(this.scroller.distance, element.scrollHeight);
    if (this.session) this.scroller.setFooterPreserveDisabled(true);
  }

  private placement(distance: number, scrollHeight: number): Placement {
    return {
      distance,
      scrollHeight,
      place: !this.session || distance - this.spacer.value <= PLACE_WITHIN_PX,
    };
  }

  /** Places the user's new turn, or keeps the view where it was when they sent from far up. */
  private applyPlacement(placement: Placement): void {
    const element = this.element;
    if (!element) return;
    this.dispatch({ type: "placed" });
    if (placement.place) {
      this.place();
      return;
    }
    this.rise.set(0);
    this.clearSpacer(false);
    this.scroller.scrollToDistance(placement.distance + element.scrollHeight - placement.scrollHeight);
  }

  /** Raises the new turn to the upper third of the view, with room for its answer below. */
  private place(): void {
    const element = this.element;
    if (!element) return;
    const target = spacerTarget(element);
    if (!this.session) {
      this.scroller.hold();
      this.consumePending = 0;
      this.spacerHidden = false;
      this.setSpacer(target);
      this.scroller.scrollToDistance(PLACED_DISTANCE_PX);
      return;
    }
    const old = this.spacer.value;
    this.spacer.stop();
    this.spacerHidden = false;
    this.rise.set(old);
    this.scroller.scrollToDistance(PLACED_DISTANCE_PX);
    this.rise.animateTo(0);
    if (old !== target) {
      this.opening = target;
      this.spacer.animateTo(target);
    }
  }

  private dispatch(event: FollowEvent): void {
    const next = nextFollowMode(this.mode, event);
    if (next === this.mode) return;
    this.mode = next;
    this.scroller.setFooterPreserveDisabled(this.turn.live && preserving(next));
  }

  /**
   * The rows changed, or what they say about the newest turn. `appended` are rows added after
   * all the others: laid out bottom-up they would push the view up, so a view that doesn't
   * follow the end grows its distance by their height and stays on what it shows.
   */
  update(rows: HTMLElement[], appended: readonly HTMLElement[]): void {
    this.rows = rows;
    const previous = this.turn;
    const turn = this.readTurn();
    this.turn = turn;
    const element = this.element;
    if (!element) return;
    const distanceBefore = this.scroller.distance;
    // Each row adds its height and the gap before it.
    const gap = appended.length > 0 ? Number.parseFloat(getComputedStyle(this.group).rowGap) || 0 : 0;
    let added = 0;
    for (const row of appended) {
      const height = row.getBoundingClientRect().height;
      this.heights.set(row, height);
      added += height + gap;
    }
    const placing = turn.key !== previous.key && this.pending !== null;
    const following =
      this.scroller.following && this.spacer.value === 0 && this.scroller.distance <= AT_BOTTOM_PX;
    if (added > 0 && !placing && !following && this.restoring === null) {
      // The answer's row joining its question's turn grows into a chat's room, like any growth
      // of the newest turn; anything else keeps the view on what it shows.
      const sameTurn = turn.key !== null && turn.key === previous.key;
      if (!this.session && sameTurn && this.spacer.value > 0) this.growIntoSpacer(added, added);
      else this.scroller.compensate(this.scroller.distance + added);
    }

    if (turn.key === null) {
      if (previous.key !== null) {
        this.dispatch({ type: "removed" });
        this.rise.set(0);
        this.clearSpacer(false);
      }
      return;
    }
    if (turn.key !== previous.key) {
      const pending = this.pending;
      this.pending = null;
      this.unplaced = null;
      if (pending) {
        this.applyPlacement(pending);
      } else if (!this.placedOnce && previous.key === null) {
        this.start(turn);
      } else {
        this.unplaced = {
          key: turn.key,
          atMs: performance.now(),
          distance: distanceBefore,
          scrollHeight: element.scrollHeight - added,
        };
      }
      this.placedOnce = true;
    }
    if (!this.session) return;
    if (turn.phase !== previous.phase) {
      const before = this.mode;
      this.dispatch({ type: "phase_changed", previous: previous.phase, phase: turn.phase });
      if (previous.phase === "prework" && turn.phase === "final_answer" && before === "prework_follow") {
        this.rise.set(0);
        this.clearSpacer(false);
        this.scroller.scrollToDistance(0);
      }
    }
    if (previous.live && !turn.live) {
      this.rise.set(0);
      this.spacer.stop();
      this.scroller.setFooterPreserveDisabled(false);
    }
  }

  /**
   * The thread's first turn on showing it: reopens where the user left it. A turn still working
   * that wasn't seen before (the first message of a new conversation, sent from the new-chat
   * view) is placed as if sent here.
   */
  private start(turn: Turn): void {
    const kept = this.saveKey === null ? undefined : saved.get(this.saveKey);
    if (turn.live && kept?.turnKey !== turn.key) {
      this.place();
      return;
    }
    const distance = kept?.distance ?? 0;
    if (this.session) {
      this.mode =
        turn.live && distance <= AT_BOTTOM_PX
          ? turn.phase === "prework"
            ? "prework_follow"
            : "user_follow"
          : kept?.turnKey === turn.key
            ? (kept?.mode ?? "static")
            : "static";
      this.scroller.setFooterPreserveDisabled(turn.live && preserving(this.mode));
    }
    if (distance > AT_BOTTOM_PX) {
      this.restoring = distance;
      this.scroller.hold();
      // After the rows have laid out (two frames: measure, then paint).
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (this.restoring !== null) this.scroller.scrollToDistance(this.restoring);
          this.restoring = null;
        }),
      );
    }
  }

  /** Saves where the thread is, for when it shows again. */
  save(): void {
    const element = this.element;
    if (this.saveKey === null || !element) return;
    const distance = this.scroller.distance;
    const spacer = this.spacer.value;
    const visibleRoom = Math.max(0, spacer - distance - scrollPaddingBottom(element));
    saved.set(
      this.saveKey,
      this.session && visibleRoom > SPACER_SLACK_PX
        ? {
            distance: 0,
            mode: nextFollowMode(this.mode, { type: "scroll_to_bottom", phase: this.turn.phase }),
            turnKey: this.turn.key,
          }
        : { distance: Math.max(0, distance - spacer), mode: this.mode, turnKey: this.turn.key },
    );
  }

  /* --- content changing size -------------------------------------------------------------- */

  /**
   * Rows changed height. Rows from the first one fully in view down keep their place (the
   * distance grows by what they grew), rows above it change nothing on screen; at the end the
   * thread follows. The newest turn of a session that works is kept by its follow mode.
   */
  rowsResized(entries: readonly ResizeObserverEntry[]): void {
    const element = this.element;
    if (!element || this.restoring !== null) {
      for (const entry of entries) this.heights.set(entry.target, this.heightOf(entry));
      return;
    }
    const changes = new Map<Element, number>();
    for (const entry of entries) {
      const height = this.heightOf(entry);
      const before = this.heights.get(entry.target);
      this.heights.set(entry.target, height);
      if (before !== undefined && before !== height) changes.set(entry.target, height - before);
    }
    if (changes.size === 0) return;

    const last = this.rows[this.rows.length - 1];
    const latestLive = this.session && this.turn.live;
    const viewTop = element.getBoundingClientRect().top;
    // From the end up: a row's old top is its new top plus its growth and the growth below it.
    let below = 0;
    let anchored = 0;
    let latestDelta = 0;
    for (let index = this.rows.length - 1; index >= 0; index--) {
      const row = this.rows[index];
      if (!row) continue;
      const delta = changes.get(row) ?? 0;
      if (delta !== 0) {
        const oldTop = row.getBoundingClientRect().top + delta + below;
        if (row === last) latestDelta = delta;
        if (!(row === last && latestLive) && oldTop >= viewTop - 1) anchored += delta;
      }
      below += delta;
    }

    const distance = this.scroller.unrounded(distanceFromBottom(element));
    const spacer = this.spacer.value;
    const following = this.scroller.following && spacer === 0 && distance <= AT_BOTTOM_PX;

    if (latestLive) {
      if (this.mode === "user_follow" || (this.mode === "prework_follow" && this.turn.phase === "prework")) {
        this.scroller.scrollToDistance(0);
        return;
      }
      if (preserving(this.mode)) {
        let target = distance + anchored + latestDelta;
        if (spacer > SPACER_SLACK_PX && target < 0) this.setSpacer(spacer - target);
        target = Math.max(0, target);
        if (target !== distance) this.scroller.scrollToDistance(target);
        this.checkFollowContent();
        return;
      }
      if (anchored !== 0) this.scroller.compensate(distance + anchored);
      return;
    }

    if (following) {
      if (distance !== 0) this.scroller.compensate(0);
      return;
    }
    if (!this.session && spacer > 0) {
      if (latestDelta > 0) {
        this.growIntoSpacer(latestDelta, anchored);
        return;
      }
      // Shrinking by more than the distance to the end would pull the view down (and reaching
      // the end takes the room away): the room grows by the difference instead.
      let target = distance + anchored;
      if (target < PLACED_DISTANCE_PX) {
        this.setSpacer(spacer + PLACED_DISTANCE_PX - target);
        target = PLACED_DISTANCE_PX;
      }
      if (target !== distance) this.scroller.compensate(target);
      return;
    }
    if (anchored !== 0) this.scroller.compensate(distance + anchored);
  }

  private heightOf(entry: ResizeObserverEntry): number {
    return entry.borderBoxSize[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
  }

  /** A session's steps reached the composer while its room still shows: follow them. */
  private checkFollowContent(): void {
    const element = this.element;
    if (
      !element ||
      this.mode !== "prework_watch" ||
      this.turn.phase !== "prework" ||
      this.spacer.value <= SPACER_SLACK_PX
    ) {
      return;
    }
    const last = this.rows[this.rows.length - 1];
    const content = last?.querySelector<HTMLElement>("[data-follow-content]") ?? last;
    if (!content) return;
    const overflowPx =
      content.getBoundingClientRect().bottom -
      element.getBoundingClientRect().bottom +
      scrollPaddingBottom(element);
    this.dispatch({ type: "follow_content_changed", overflowPx, phase: this.turn.phase });
    if ((this.mode as FollowMode) === "prework_follow") {
      this.rise.set(0);
      this.clearSpacer(false);
      this.scroller.scrollToDistance(0);
    }
  }

  /* --- the user scrolling ----------------------------------------------------------------- */

  /** Every scroll: a chat's room goes once the end is reached; a session notes it out of view. */
  scrolled(distance: number): void {
    const spacer = this.spacer.value;
    if (spacer <= 0) return;
    if (!this.session) {
      if (this.scroller.unrounded(distance) === 0) {
        this.consumePending = 0;
        this.setSpacer(0);
      }
      return;
    }
    const element = this.element;
    if (
      element &&
      distance > AT_BOTTOM_PX &&
      Math.max(0, spacer - distance - scrollPaddingBottom(element)) <= SPACER_SLACK_PX
    ) {
      this.spacerHidden = true;
    }
  }

  /** The user's own scroll. */
  userScrolled(distance: number, previous: number): void {
    this.restoring = null;
    if (!this.session) {
      // Scrolling away from the end takes as much out of the room, so there is no empty space
      // to scroll back into.
      if (this.spacer.value <= 0 || distance <= previous) return;
      this.consumePending += distance - previous;
      this.consumeFrame ??= requestAnimationFrame(() => {
        this.consumeFrame = null;
        const px = this.consumePending;
        this.consumePending = 0;
        this.consume(px);
      });
      return;
    }
    const spacer = this.spacer.value;
    if (distance <= AT_BOTTOM_PX) {
      if ((spacer <= SPACER_SLACK_PX || this.spacerHidden) && previous > AT_BOTTOM_PX && this.turn.live) {
        this.dispatch({ type: "scroll_to_bottom", phase: this.turn.phase });
        this.scroller.scrollToDistance(0);
      }
      return;
    }
    this.dispatch({ type: "scroll_distance_changed", distance, phase: this.turn.phase });
    if (
      spacer > SPACER_SLACK_PX &&
      ((!this.turn.live && this.turn.phase === "idle") || (this.turn.live && distance > previous))
    ) {
      this.trimSpacer(spacer - distance);
    }
  }

  /** How much of the room shows in the view (the intersection observer's report). */
  spacerIntersection(visible: number): void {
    const element = this.element;
    if (!element || this.spacer.value <= 0) return;
    if (!this.session) {
      this.checkSpacerVisible();
      return;
    }
    if (this.turn.live) {
      if (visible - scrollPaddingBottom(element) <= SPACER_SLACK_PX) this.spacerHidden = true;
      return;
    }
    this.trimSpacer(Math.min(visible, this.spacer.value - this.scroller.distance));
  }

  /** The scroll button: to the end, and following the turn if it still works. */
  scrollToBottom(): void {
    if (!this.session) {
      this.setSpacer(0);
      this.scroller.scrollToBottom();
      return;
    }
    if (this.turn.live) {
      this.rise.set(0);
      this.clearSpacer(false);
      this.dispatch({ type: "scroll_to_bottom", phase: this.turn.phase });
      this.scroller.scrollToDistance(0);
      return;
    }
    if (this.spacer.value > SPACER_SLACK_PX) {
      this.clearSpacer(false);
      this.scroller.scrollToDistance(0);
      return;
    }
    this.scroller.scrollToBottom();
  }

  dispose(): void {
    this.save();
    this.spacer.stop();
    this.rise.stop();
    if (this.consumeFrame !== null) cancelAnimationFrame(this.consumeFrame);
    this.scroller.setFooterPreserveDisabled(false);
    this.scroller.spacerHeight = () => 0;
  }
}
