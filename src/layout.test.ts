/**
 * The vertical budget of the thread column, at the window's own 800x500 minimum.
 *
 * # What this is, and what it is not
 *
 * **jsdom has no layout.** Every element measures 0x0, `getComputedStyle` resolves nothing this
 * stylesheet declares, and no test in this repository can see a pixel. So this file does not
 * prove that Allow and Deny are on screen, or that the plan card does not overlap the feed's
 * toggle. It proves the two things a test *can* prove about geometry without a renderer:
 *
 *   1. **The declarations that make the geometry work are present**, so the fix cannot be
 *      deleted or reverted in a later edit without something going red.
 *   2. **The arithmetic those declarations imply adds up at 500px**, which is the check that
 *      caught the numbers being wrong while they were being chosen.
 *
 * Both defects it guards were confirmed by the owner in a real window on 2026-09-04, and neither
 * was visible to any test here — `docs/STATUS.md` §5 defect 3 predicted the approvals one and
 * could not confirm it, because the store's one approval was already resolved and
 * `pending_approvals` came back empty. **A human still has to look at the window.** That is said
 * here rather than left to be inferred.
 *
 * # Why it reads the stylesheet as text
 *
 * Same reason and same mechanism as `src/index.css.test.ts`: Vitest stubs CSS modules and the
 * stub beats `?raw`, so a `?raw` import returns `""` and every assertion below would pass
 * vacuously. It is read with `node:fs` through an assembled specifier, because `tsconfig.json`
 * carries no `types` entry and a literal `import "node:fs"` is a `tsc --noEmit` error.
 */
import { describe, expect, it } from "vitest";

import { ROW_H } from "./components/Feed";

interface FsLike {
  readFileSync(path: string, encoding: "utf8"): string;
}
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as FsLike;

const CSS_PATH = "src/index.css";

function cssText(): string {
  return fs.readFileSync(CSS_PATH, "utf8");
}

/**
 * The declarations of one rule, by exact selector.
 *
 * Comments are stripped first — this file's own arithmetic is repeated inside `src/index.css`,
 * and a comment naming `min-height` would otherwise satisfy a check for the declaration. `nth`
 * picks a later block when a selector is declared more than once (the `@media` overrides).
 */
function rule(selector: string, nth = 0): string {
  const css = cssText().replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blocks = [...css.matchAll(new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, "gm"))];
  const block = blocks[nth];
  if (block === undefined) {
    throw new Error(`no rule ${nth} for \`${selector}\` in ${CSS_PATH} (found ${blocks.length})`);
  }
  return block[1]!;
}

/** One declaration's value, trimmed, or null when the rule does not carry it. */
function decl(selector: string, property: string, nth = 0): string | null {
  const m = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "m").exec(rule(selector, nth));
  return m === null ? null : m[1]!.trim();
}

/** A `px` value as a number. Throws rather than returning NaN, so a unit change is loud. */
function px(selector: string, property: string, nth = 0): number {
  const value = decl(selector, property, nth);
  const m = value === null ? null : /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (m === null) throw new Error(`\`${selector} { ${property} }\` is ${value}, not a px value`);
  return Number(m[1]);
}

/** A custom property declared on `:root`. */
function token(name: string): number {
  const m = new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(
    cssText().replace(/\/\*[\s\S]*?\*\//g, ""),
  );
  if (m === null) throw new Error(`no --${name} in ${CSS_PATH}`);
  return Number(m[1]);
}

/** The app's own minimum, from `src-tauri/tauri.conf.json`. Not read from there: this test owns
 *  `src/` only, and a Rust-side change to the minimum is a reason for this number to be wrong
 *  loudly rather than a reason to reach across the boundary. */
const MIN_WINDOW_H = 500;

/** `.dock`, derived from its own rules: 12 + 14 padding, a 38px context strip pulled up 10 by its
 *  negative margin, and a box of 10 + 10 padding + a 2-row textarea + a 32px action row. The
 *  order R2 quotes the same 160 from the real window. */
const DOCK_H = 160;

describe("R2.4 — the plan card cannot paint over the feed's toggle", () => {
  /**
   * The mechanism, for whoever reads this next: `.feed` already reserves the band's 20px with
   * `padding-top`, so in normal flow the two never meet. `.run-card` was `flex: 0 1 auto` with
   * `min-height: 0` — the pair that lets a flex item shrink past its own content — and carried no
   * `overflow`, so what it was squeezed out of it drew anyway, on top of whatever came next.
   */
  it("cannot be squeezed under its own collapsed line", () => {
    const floor = px(".run-card", "min-height");
    // The collapsed line is `.run-toggle` (11px at 1.45 + 4 padding + 2 border = 22) inside
    // `.run-line` (4 + 4) inside the card's own 8px padding-top.
    expect(floor).toBeGreaterThanOrEqual(38);
  });

  it("clips rather than overlaps whatever the floor does not cover", () => {
    expect(decl(".run-card", "overflow")).toBe("hidden");
  });

  it("keeps a home for everything it might have clipped", () => {
    // Both of the card's long lists scroll inside it, so `overflow: hidden` above never eats a
    // phase or an unsettled intent — it only stops one being painted outside the card.
    expect(decl(".run-phases", "overflow-y")).toBe("auto");
    expect(decl(".run-intent-list", "overflow-y")).toBe("auto");
    expect(decl(".run-intents", "flex")).toBe("0 1 auto");
  });

  it("still reserves the band's height inside the feed, so nothing sits on row 0", () => {
    expect(decl(".feed", "padding-top")).toBe("20px");
  });
});

describe("R2.3 — the approval decision is never below the fold", () => {
  it("makes the card a column whose head and actions do not yield", () => {
    expect(decl(".approval", "display")).toBe("flex");
    expect(decl(".approval", "flex-direction")).toBe("column");
    expect(decl(".approval-head", "flex")).toBe("0 0 auto");
    expect(decl(".approval-actions", "flex")).toBe("0 0 auto");
  });

  it("makes the excerpt the only thing that yields, and scrolls what it gives up", () => {
    expect(decl(".approval-body", "flex")).toBe("1 1 auto");
    expect(decl(".approval-body", "min-height")).toBe("0");
    expect(decl(".approval-body", "overflow-y")).toBe("auto");
  });

  it("floors the card at the height its own decision needs", () => {
    // 20 padding + 2 border + ~20 head + 28 `.act` + 10 margin = 80.
    expect(px(".approval", "min-height")).toBeGreaterThanOrEqual(80);
  });

  /**
   * The check that caught the numbers being wrong while they were being chosen. Every term is a
   * declaration in this stylesheet, so a later edit that takes the room back fails here rather
   * than in the owner's window.
   */
  it("leaves an open approval room to draw its decision at 800x500", () => {
    const head = token("head-h");
    const feedFloor = px(".feed", "min-height", 1); // the `@media (max-height: 560px)` override
    const cardFloor = px(".run-card", "min-height");
    const approvalFloor = px(".approval", "min-height");
    // `.approvals-head` is 12px text at 1.45 with 6px of padding twice; `.approvals-body` adds
    // 4px of padding-bottom.
    const approvalsChrome = 29 + 4;

    const needed =
      head + cardFloor + feedFloor + DOCK_H + approvalsChrome + approvalFloor;
    expect(needed).toBeLessThanOrEqual(MIN_WINDOW_H);
    // …and it is not merely scraping in: there is room for some of the excerpt too.
    expect(MIN_WINDOW_H - needed).toBeGreaterThanOrEqual(20);
  });

  it("buys that room with whole feed rows, never a row cut through its glyphs", () => {
    const band = px(".feed", "padding-top");
    for (const nth of [0, 1]) {
      const floor = px(".feed", "min-height", nth);
      expect((floor - band) % ROW_H).toBe(0);
    }
    // The short-window floor is smaller than the ordinary one; if it were not, the media query
    // would be doing nothing and the budget above would be a fiction.
    expect(px(".feed", "min-height", 1)).toBeLessThan(px(".feed", "min-height", 0));
  });
});

describe("R2.2 — there is one composer, so there is one column of height to budget", () => {
  it("has no run strip of its own left to stack above the dock", () => {
    // `.run-dock` and `.run-dock-input` were the second text field. The 40px they occupied is
    // what the budget above spends on the approval card.
    const css = cssText().replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/(?:^|[},])\s*\.run-dock\s*\{/m);
    expect(css).not.toMatch(/(?:^|[},])\s*\.run-dock-input\s*\{/m);
  });

  it("puts the mode chooser inside the context strip, where it costs no height", () => {
    // A chooser on a row of its own would have given back with one hand what removing the run
    // strip took with the other. `.dock-context` keeps its measured 38px.
    expect(decl(".dock-context", "height")).toBe("38px");
    expect(decl(".dock-modes", "flex")).toBe("0 0 auto");
  });
});
