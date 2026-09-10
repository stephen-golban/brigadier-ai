/**
 * A guard, not a rendering test. jsdom does not resolve `@import`, does not apply cascade
 * layers and does not compute `box-shadow`, so the only honest thing to assert here is that
 * the reset file still exists, is still reachable from the stylesheet entry point, and still
 * carries the selectors that do the work. Anything stronger would be theatre.
 *
 * The real proof is the emitted stylesheet: `npx @tailwindcss/cli -i src/index.css -o out.css`
 * and read the focus rules off it. That is a manual gate, recorded in `docs/STATUS.md` §7.
 *
 * Owner decision, restated 2026-09-11: NO visible focus indicator anywhere in the app.
 */
import { expect, it } from "vitest";

interface Files {
  readFileSync: (path: string, encoding: "utf8") => string;
}
const fs = (await import(
  /* @vite-ignore */ "node:" + "fs"
)) as unknown as Files;

const reset = fs.readFileSync("src/focus-reset.css", "utf8");
const entry = fs.readFileSync("src/index.css", "utf8");

it("is imported from the stylesheet entry point", () => {
  // Without this line nothing below is loaded at all.
  expect(entry).toContain('@import "./focus-reset.css";');
});

it("neutralises rings on every focus state, not just a gated subset", () => {
  // The gate this replaced was `[class*="focus-visible:ring"]`, which missed
  // `ui/field.tsx`'s `has-[>[data-slot=field]]:has-[:focus-visible]:ring-3` twice over: the
  // literal substring is `focus-visible]:ring`, and the compiled selector is
  // `:has(:focus-visible)` rather than `:focus-visible`.
  for (const state of [
    ":focus",
    ":focus-visible",
    ":focus-within",
    "[data-focus-visible]",
    "[data-focus]",
  ])
    expect(reset).toContain(state);
  for (const property of [
    "--tw-ring-color: transparent !important",
    "--tw-ring-shadow: 0 0 #0000 !important",
    "--tw-ring-offset-shadow: 0 0 #0000 !important",
  ])
    expect(reset).toContain(property);
});

it("keeps the decorative non-focus hairlines out of the ring reset", () => {
  // These five kit surfaces draw a hairline with a STATIC `ring-1 ring-foreground/10` (or
  // `ring-2 ring-background` on avatars) and carry no focus ring of their own. Base UI
  // focuses a popup the moment it opens, so an unqualified reset erases them on open.
  for (const slot of [
    '[data-slot="popover-content"]',
    '[data-slot="dialog-content"]',
    '[data-slot="select-content"]',
    '[data-slot="dropdown-menu-content"]',
    '[data-slot="avatar"]',
    "[data-sonner-toast]",
  ])
    expect(reset).toContain(slot);
});

it("sweeps outlines with !important so file order cannot matter", () => {
  expect(reset).toMatch(/\*,\s*\n\s*\*::before,\s*\n\s*\*::after/);
  expect(reset).toContain("outline: none !important");
});

it("puts every kit focus border back to its own resting colour", () => {
  // `focus-visible:border-ring` is a 1px `var(--ring)` edge — a focus indicator by another
  // name. Nine kit components carry it and each rests on a different value.
  for (const slot of [
    "button",
    "badge",
    "input",
    "textarea",
    "select-trigger",
    "tabs-trigger",
    "checkbox",
    "toggle",
    "switch",
  ])
    expect(reset).toContain(`[data-slot="${slot}"]`);
  // No rule in this file may hand `var(--ring)` back to a border; that is the colour being
  // removed. It appears in the prose above rule 3 and nowhere in a declaration.
  expect(reset).not.toMatch(/^\s*border-color: var\(--ring\)/m);
});

it("covers the hand-written focus edges that live outside Tailwind", () => {
  for (const selector of [
    // `src/index.css`: a `#578cdd` border on the rename field.
    ".rename-session-dialog input.input:focus",
    // `src/index.css`: a bottom rule swapped in on the note title.
    ".note-title-input:focus-visible",
    // `src/intro.css`: a 3px accent halo on the opening screen's name field.
    ".welcome-name input:focus",
    // `src/index.css`: the splitter's 2px `var(--ring)` bar.
    ".layout-resizer:focus-visible::after",
    // `src/components/EditProjectDialog.tsx`.
    '[class~="focus-within:border-text-tertiary"]:focus-within',
  ])
    expect(reset).toContain(selector);
});

it("leaves the splitter's hover line alone", () => {
  // Hover is not focus. A splitter with no hover affordance is not findable with a mouse.
  expect(reset).toContain(".layout-resizer:hover::after");
});

it("switches Monaco's and the workbench's focus colours off in the theme", () => {
  // CSS cannot reach these: Monaco and the VS Code workbench paint them from theme data.
  const editor = fs.readFileSync("src/components/CodeEditor.tsx", "utf8");
  const workbench = fs.readFileSync("src/vscode-panels/runtime.ts", "utf8");
  expect(editor).toContain('const TRANSPARENT = "#00000000"');
  expect(editor).toContain("focusBorder: TRANSPARENT");
  expect(editor).toContain('"list.focusOutline": TRANSPARENT');
  expect(editor).not.toContain("focusBorder: secondary");
  expect(workbench).toContain('focusBorder: "#00000000"');
  expect(workbench).toContain('"list.focusOutline": "#00000000"');
});
