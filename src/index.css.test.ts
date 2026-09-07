/**
 * The standing gate on `src/index.css`'s scanner policy.
 *
 * # Why this file exists
 *
 * Tailwind's oxide scanner walks the FILESYSTEM, not the module graph. Until 2026-09-03 it was
 * pointed at the whole repository and fenced with a blacklist (`@source not "../docs"`), chosen
 * over a whitelist for a stated reason: *"whitelisting fails silent for future orders."*
 *
 * The blacklist is what failed silently, twice, from two directories nobody thought to enumerate:
 * `docs/` (prose naming `bg-accent`), and `crates/proc/src/pidfile.rs:19`, whose doc comment says
 * "a different kernel — a **container**, a VM" and shipped six `.container` rules into production
 * for weeks. `src/index.css` now whitelists instead. **This file is the thing that makes the
 * stated worry untrue rather than merely dismissed.**
 *
 * # The hazard it gates
 *
 * Over-exclusion, in one direction only: **a class the markup uses whose rule is not emitted.**
 * That fails as an unstyled element with no error anywhere, which is the same failure mode
 * `@theme static` exists to prevent (`docs/research/frontend-stack.md` §2.2). A narrowed scanner
 * causes it silently; this test converts it into a red gate.
 *
 * The invariant that makes a cheap check sufficient: **this app styles itself entirely by hand.**
 * Every class in every component resolves through a rule written in `src/index.css`; not one
 * Tailwind utility class is used anywhere (measured 2026-09-04, and it is why narrowing the
 * scanner dropped 2.51 kB of generated rules without changing a pixel). So "is this class
 * hand-written?" and "will this class be styled?" are the same question, and answering it needs
 * no build.
 *
 * **It deliberately reads the hand-written `src/index.css`, never the built bundle.** Two class
 * names in this app — `grow` and `sr-only` — are also Tailwind utility names, and today the
 * bundle carries a generated rule for each *in addition* to the hand-written ones. Checking the
 * bundle would let those pass on the generated rule and hide the day the generated rule goes
 * away. Checking the source is what makes a new dependency on generation fail here.
 *
 * # What this does NOT cover, stated so it is not mistaken for more than it is
 *
 *   - **Leaks.** It gates styles going missing, not noise arriving. A scanner widened back to the
 *     whole repo would re-leak `.container` and this test would stay green; `scanner policy`
 *     below is the (weaker, textual) guard for that direction.
 *   - **Dynamically built class names** — string concatenation, a lookup table, a `clsx`-style
 *     helper. Only literals inside a `class`/`className` attribute are seen.
 *   - **Files outside the scanned roots.** It reads the same set `src/index.css` declares, and
 *     `scanner policy` fails if that set changes without this file changing with it.
 *   - **Whether a hand-written rule actually applies.** `.side-section .grow` counts as defining
 *     `grow`; that the element is really inside a `.side-section` is not checked.
 *
 * Mechanics match `src/feedStore.test.ts`: `globals: false`, so every helper is imported.
 */
import { describe, expect, it } from "vitest";

/**
 * The `.tsx` and `.html` sources come through `import.meta.glob(… ?raw)`, which Vite inlines at
 * transform time — no filesystem call, and typed by `vite/client`, which `src/vite-env.d.ts`
 * already references.
 *
 * **`src/index.css` cannot come the same way.** Vitest stubs CSS modules, and the stub beats
 * `?raw`: measured 2026-09-04, both `import.meta.glob("./index.css", { query: "?raw" })` and a
 * static `import css from "./index.css?raw"` return an empty string, not the file. A gate reading
 * `""` would have passed vacuously while checking nothing, which is worse than no gate — so it is
 * read with `node:fs` instead.
 *
 * The specifier is assembled rather than written, and that is not decoration. `tsconfig.json`
 * carries no `types` entry — deliberately; `vitest.config.ts` records that `globals: false` is
 * what keeps `npx tsc --noEmit` green without one — so a literal `import "node:fs"` is
 * `TS2307: Cannot find module` and turns a build gate red (measured). A non-literal specifier is
 * not resolved by TypeScript, and `@vite-ignore` stops Vite trying to bundle a Node builtin. The
 * alternative was declaring `node:fs` ambiently in a `.d.ts`, which would hand the whole project
 * a hand-written and probably wrong `fs` type to satisfy one test.
 */
interface FsLike {
  readFileSync(path: string, encoding: "utf8"): string;
}
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as FsLike;

/** Relative to the repository root, which is Vitest's working directory. */
const CSS_PATH = "src/index.css";

const TSX = import.meta.glob("./**/*.tsx", { query: "?raw", import: "default", eager: true });
const HTML = import.meta.glob("../index.html", { query: "?raw", import: "default", eager: true });

/**
 * The scanner's roots, mirroring `src/index.css`'s directives. `scanner policy` below fails if
 * the two lists drift, so widening the scanner without widening this test is not possible
 * quietly — which is the whole objection to whitelists, answered.
 */
const SCANNED_ROOTS = ["src/**/*.tsx", "index.html"] as const;
const NOT_SCANNED = ["src/**/*.test.tsx"] as const;

/**
 * Class attributes that no rule matches, and that is known and deliberate.
 *
 * This list is the permanent record of what the gate found on its first run, rather than a
 * silence: three attributes across the whole app draw nothing at all. None is a visual bug — each
 * is a hook whose layout comes from its parent — but each reads like a styled class and is not.
 * The list shrinks the day anyone styles one. It must never grow to accommodate a **utility**
 * class: a Tailwind name landing here would be the exact failure this file gates, laundered into
 * an exemption.
 */
const UNSTYLED_HOOKS = new Map<string, string>([
  ["burn", "`<details className=\"burn\">` in the dev-only Burn panel; predates W4, no rule ever"],
  ["mark-t", "the clock inside `.feed-mark`; spacing is the parent's `display: flex; gap: 8px`"],
  ["mark-s", "the session ref inside `.feed-mark`; same, and W4-D2 may style both by kind"],
]);

/* ------------------------------------------------------------------ sources */

/** Every file the scanner is pointed at: non-test `.tsx` under `src/`, plus `index.html`. */
function markupSources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [path, text] of Object.entries(TSX)) {
    if (path.endsWith(".test.tsx")) continue;
    out.push([path.replace(/^\.\//, "src/"), text as string]);
  }
  for (const [, text] of Object.entries(HTML)) out.push(["index.html", text as string]);
  return out;
}

/** The stylesheet, as text. Non-empty is asserted below; an empty read is the vacuous-pass trap
 *  this whole file exists to avoid. */
function cssText(): string {
  return fs.readFileSync(CSS_PATH, "utf8") + "\n" + fs.readFileSync("src/chat.css", "utf8") + "\n" + fs.readFileSync("src/workbench.css", "utf8") + "\n" + fs.readFileSync("src/desktop.css", "utf8") + "\n" + fs.readFileSync("src/launch.css", "utf8");
}

/** Every string literal in a JSX expression, with `${…}` interpolations blanked out. */
function literalsIn(expr: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < expr.length; i += 1) {
    const q = expr[i];
    if (q !== '"' && q !== "'" && q !== "`") continue;
    let buf = "";
    let j = i + 1;
    while (j < expr.length && expr[j] !== q) {
      if (expr[j] === "\\") {
        j += 2;
        continue;
      }
      if (q === "`" && expr[j] === "$" && expr[j + 1] === "{") {
        let depth = 1;
        j += 2;
        while (j < expr.length && depth > 0) {
          if (expr[j] === "{") depth += 1;
          if (expr[j] === "}") depth -= 1;
          j += 1;
        }
        buf += " ";
        continue;
      }
      buf += expr[j];
      j += 1;
    }
    out.push(buf);
    i = j;
  }
  return out;
}

/** Class tokens → the files that use them. Literals only; see the header. */
function classesUsed(): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  for (const [file, text] of markupSources()) {
    const attr = /class(?:Name)?\s*=\s*/g;
    let m: RegExpExecArray | null;
    while ((m = attr.exec(text)) !== null) {
      let i = m.index + m[0].length;
      const literals: string[] = [];
      const q = text[i];
      if (q === '"' || q === "'") {
        const end = text.indexOf(q, i + 1);
        if (end === -1) continue;
        literals.push(text.slice(i + 1, end));
      } else if (q === "{") {
        let depth = 1;
        let j = i + 1;
        while (j < text.length && depth > 0) {
          const c = text[j];
          if (c === '"' || c === "'" || c === "`") {
            const s = c;
            j += 1;
            while (j < text.length && text[j] !== s) j += text[j] === "\\" ? 2 : 1;
          } else if (c === "{") depth += 1;
          else if (c === "}") depth -= 1;
          j += 1;
        }
        literals.push(...literalsIn(text.slice(i + 1, j - 1)));
      } else continue;
      for (const lit of literals) {
        for (const cls of lit.split(/\s+/)) {
          if (cls === "") continue;
          const at = used.get(cls) ?? new Set<string>();
          at.add(file);
          used.set(cls, at);
        }
      }
    }
  }
  return used;
}

/** Class names a hand-written rule mentions. Comments are stripped first: this file's own prose,
 *  and `index.css`'s, name plenty of classes that nothing draws. */
function classesDefined(): Set<string> {
  const css = cssText().replace(/\/\*[\s\S]*?\*\//g, "");
  return new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!));
}

/* -------------------------------------------------------------------- tests */

describe("the class extractor", () => {
  /**
   * The anti-vacuity guard, and it is not ceremony. The gate below passes trivially against an
   * empty set, so a regex that silently stops matching would read as protection while checking
   * nothing — the same trap `Feed.test.tsx`'s virtualizer test avoids by forcing `offsetHeight`
   * (jsdom measures 0x0, so without it the windowing assertion passes against an empty pane).
   */
  it("finds the app's classes, so the gate below cannot pass on an empty set", () => {
    const used = classesUsed();
    expect(used.size).toBeGreaterThan(60);
    for (const known of ["sidebar", "feed-row", "feed-line", "dock-box", "jump-pill", "thread"]) {
      expect(used.has(known)).toBe(true);
    }
  });

  it("actually loads the stylesheet, which is the trap that caught this test itself", () => {
    // Vitest returned "" for every `?raw` import of a CSS file. With an empty stylesheet the
    // orphan gate below fails loudly rather than passing, and so do both policy tests — but an
    // explicit assertion says which of the three is really broken.
    expect(cssText().length).toBeGreaterThan(10_000);
    expect(classesDefined().size).toBeGreaterThan(60);
  });

  it("reads through ternaries and template literals, not just plain attributes", () => {
    // `Feed.tsx` writes `className={lead ? "feed-row lead" : "feed-row"}`; `Sidebar.tsx` and
    // `Approvals.tsx` build theirs with template literals. All three shapes must be seen.
    const used = classesUsed();
    expect(used.has("lead")).toBe(true);
    expect(used.has("project-row")).toBe(true);
  });

  it("does not mistake JavaScript for class names", () => {
    const used = classesUsed();
    for (const junk of ["?", ":", "session.busy", "readOnly", '"']) {
      expect(used.has(junk)).toBe(false);
    }
  });
});

describe("every class the markup uses is styled by hand", () => {
  it("has a rule in src/index.css, or is a declared unstyled hook", () => {
    const defined = classesDefined();
    const orphans: string[] = [];
    for (const [cls, files] of classesUsed()) {
      if (defined.has(cls) || UNSTYLED_HOOKS.has(cls)) continue;
      orphans.push(`  .${cls}  used in ${[...files].sort().join(", ")}`);
    }
    expect(
      orphans.join("\n"),
      [
        "These classes appear in markup but no rule in src/index.css defines them.",
        "",
        "If you meant a Tailwind utility: this project does not use them. The scanner is",
        "whitelisted to " + SCANNED_ROOTS.join(" and ") + ", and a utility outside that scope",
        "is never generated — the element would render unstyled with no error. Either write",
        "the rule in src/index.css, or widen the scanner deliberately and update SCANNED_ROOTS.",
        "",
        "If the class is a deliberate hook that draws nothing, add it to UNSTYLED_HOOKS with a",
        "reason. Never add a Tailwind utility name there.",
      ].join("\n"),
    ).toBe("");
  });

  it("keeps UNSTYLED_HOOKS honest: every entry is still unstyled and still used", () => {
    // An entry that has since been given a rule, or whose markup is gone, is a stale exemption.
    const defined = classesDefined();
    const used = classesUsed();
    for (const [cls, why] of UNSTYLED_HOOKS) {
      expect(defined.has(cls), `.${cls} now has a rule; drop it from UNSTYLED_HOOKS (${why})`).toBe(
        false,
      );
      expect(used.has(cls), `.${cls} is no longer used; drop it from UNSTYLED_HOOKS`).toBe(true);
    }
  });
});

describe("scanner policy", () => {
  const css = cssText;

  /** Textual, and weaker than the gate above on purpose — it guards the other direction (noise
   *  arriving) which cannot be seen without a build. Its job is to make a quiet return to
   *  whole-repository scanning impossible. */
  it("disables automatic whole-repository detection", () => {
    expect(css()).toContain('@import "tailwindcss" source(none);');
  });

  it("declares exactly the roots this test checks", () => {
    /*
     * Matched at the start of a line, which is where a directive sits and where prose about one
     * never does (every comment line in that file begins " * "). The obvious alternative —
     * stripping comments first — is wrong, and this test caught it: `"../src/**\/*.tsx"` contains
     * a literal `/*` … `*\/` pair, so a CSS comment stripper eats the middle of the glob and the
     * directive reads back as `../src*.tsx`.
     */
    const directives = [...css().matchAll(/^@source\s+(not\s+)?"([^"]+)"/gm)];
    const rel = (p: string) => p.replace(/^\.\.\//, "");
    const positive = directives.filter((m) => m[1] === undefined).map((m) => rel(m[2]!));
    const negative = directives.filter((m) => m[1] !== undefined).map((m) => rel(m[2]!));
    expect(positive.sort()).toEqual([...SCANNED_ROOTS].sort());
    expect(negative.sort()).toEqual([...NOT_SCANNED].sort());
  });
});
