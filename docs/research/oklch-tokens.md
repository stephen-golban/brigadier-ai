# The measured palette as Tailwind 4 `@theme` tokens in oklch

Converted 2026-09-02, against this repo's own build. Every `[measured]` line below was produced by
a script that was run, or by a `vite build` whose output is quoted verbatim. Nothing was answered
from memory and nothing was hand-converted.

Implements W4-B. The palette itself is not this file's work — it was sampled pixel by pixel from
the ChatGPT macOS app (26.825.51511) and is recorded in `docs/plans/ui-restyle-notes.md`. This
file changes its **representation only**.

---

## Bottom line up front

1. **All 18 colour tokens round-trip bit-exact.** hex → oklch → hex returns the identical 8-bit
   hex for 18 of 18 at L 4dp / C 5dp / H 2dp **[measured]**. No colour moved.
2. **All 8 annotated contrast pairs re-derive to within 0.0017** of the ratio recorded in
   `docs/research/frontend-stack.md` §2.6 **[measured]**, well inside the 0.003 tolerance.
3. **`--text-muted-side` failed WCAG AA at 4.456:1** on `--color-sidebar-bg`, on a token already
   tagged `[contrast]` for having been lightened once to pass. The comment claimed 4.6:1. W4-B did
   not change the colour; the owner did, on 2026-09-03, to `#a5a5a5` — **4.563:1, passing**.
   Closed in §4, where the failure is kept on the record because finding it is the argument for
   this whole exercise.
4. **Three comments in `src/index.css` stated wrong ratios**, not one. All three corrected; no
   colour touched.
5. **Tailwind 4 adds zero bytes to the JS bundle**, confirmed independently here: 262.69 kB before,
   262.69 kB after **[measured]**. CSS 12.69 kB → 21.89 kB. Both JS figures are the **isolated**
   build — `HEAD` plus only this order's files (§5). The repo's own bundle at `3e5c3fd` is
   **263.28 kB**, and the 0.59 kB difference is a concurrent order's `src/paint.ts`, not Tailwind.
6. **Tailwind's scanner reads `docs/**/*.md` and turned prose into shipped CSS.** Naming
   `bg-accent` in a sentence emitted `.bg-accent` into the production bundle. Across the repo's
   docs that was **1.44 kB of CSS nothing renders**; `@source not "../docs"` in `src/index.css`
   removes it **[measured]**. See §6 — this is the most reusable thing in this file.
7. Nothing in `docs/research/frontend-stack.md` §2 turned out to be wrong. An apparent 1 kB error
   in its §2.5 CSS figure was **my** measurement error, not its — §6.

---

## 1. Method

`hex → oklch → hex` and the WCAG ratios were computed by one throwaway script, run once, with no
dependency:

```
/private/tmp/claude-501/-Users-stephen-Development-brigadier-ai/<session>/scratchpad/oklch.mjs
```

It is a scratchpad file and is **not** checked in; it is ~120 lines and reproducible from this
description alone. `culori@4.0.2` and `colorjs.io@0.7.1` exist on npm today
(`docs/research/frontend-stack.md` §2.6 **[measured]**) but neither was installed — a conversion
utility is not worth a runtime dependency, and the matrices are public.

The transform, as implemented **[documented]** (Björn Ottosson's OKLab, the same matrices the CSS
Color 4 spec carries):

- sRGB → linear: `c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4`.
- linear RGB → LMS by the 3×3 `0.4122214708 …` matrix, then a cube root of each component.
- LMS' → OKLab by the 3×3 `0.2104542553 …` matrix; `C = hypot(a,b)`, `H = atan2(b,a)` in degrees,
  normalised to `[0,360)`.
- The inverse runs the same three steps backwards, then `linear → sRGB` and `round(c*255)`.

WCAG 2.x relative luminance is `0.2126R + 0.7152G + 0.0722B` on linearised channels; the ratio is
`(Lmax+0.05)/(Lmin+0.05)`.

One detail worth recording because it could have mattered and did not: **WCAG 2.x's own text
specifies the linearisation threshold as `0.03928`, while sRGB's is `0.04045`.** Both were
computed for all 8 pairs and they agree to 4 decimal places on every one **[measured]** — e.g.
`--text-muted`/`--thread-bg` is 4.7475 either way. The choice is immaterial here. It is noted
because a reader re-deriving these numbers with a different tool may pick either.

**Rounding is L 4dp, C 5dp, H 2dp**, per `docs/research/frontend-stack.md` §2.6's measured table
(2/3/1 round-trips only 7 of 18 and drifts a ratio by up to 0.109). Achromatic greys land at
`C = 0` with a meaningless hue and are written `oklch(L 0 0)`.

### Rounding levels, re-derived

Run here with the script in §1, over the same 18 tokens and the same 8 annotated pairs §2.6 uses.
All **[measured]**, 2026-09-02.

| Rounding (L, C, H) | round-trip | break | worst drift | worst pair |
|---|---|---|---|---|
| 2, 3, 1 | 7 of 18 | 11 | 0.1097 | `--ok` on `--thread-bg`, 8.6147 → 8.7244 |
| **2, 2, 2** | **5 of 18** | **13** | **0.1045** | `--accent` on `--thread-bg`, 7.2369 → 7.3415 |
| 3, 4, 2 | 18 of 18 | 0 | 0.0185 | `--text-sidebar` on `--sidebar-bg`, 8.5938 → 8.6124 |
| **4, 5, 2** (shipped) | **18 of 18** | **0** | **0.0017** | `--accent` on `--thread-bg`, 7.2369 → 7.2386 |

Why this table exists: **§2.6's prose said "two-decimals-everywhere" while quoting the `2, 3, 1`
row's numbers**, and that mislabel was copied into `src/index.css`'s header. Both are now
corrected. The `2, 2, 2` row had never been measured by anyone; it is here so the claim the prose
was *trying* to make has a number behind it.

**Provenance, because these did not come from the original §2.6 run.** The `2, 2, 2` and `3, 4, 2`
figures were measured on 2026-09-02 during the W4-B review, independently twice — once by a blind
reviewer with its own script, once here — agreeing on both counts and on the worst drift. The
`2, 3, 1` and `4, 5, 2` rows re-derive to 0.1097 and 0.0017 against §2.6's recorded 0.109 and
0.003, so the table reproduces and the two runs are measuring the same thing.

Two things worth carrying forward:

- **`2, 2, 2` is worse than the prose claimed, not better** — 13 tokens break rather than 11. The
  argument for 4/5/2 survives the correction intact.
- **At `2, 2, 2` the drift runs the dangerous way.** When this was measured, `--text-muted-side`
  was `#a3a3a3` and genuinely failed AA at 4.4551:1 — and 2/2/2 rendered it as **4.5572:1**,
  reading as a pass. §2.6 illustrates the risk as "a 4.50:1 pair silently becomes 4.39:1"; the
  same rounding also does the reverse, which is the worse direction. The token has since been
  bumped to `#a5a5a5` and passes (§4), which sharpens the point rather than retiring it:
  **`#a3a3a3` and `#a5a5a5` both collapse to L 0.72 at two decimals and both read as 4.5572:1**
  **[measured]**, so that rounding cannot distinguish the failing value from the fix for it.
- **`3, 4, 2`'s worst drift re-derives as 0.0185, not §2.6's recorded 0.010.** Left as-is in
  §2.6's table with a footnote rather than edited: it changes no decision, since that row is not
  the one shipped. I did **not** determine which run is right.

---

## 2. The 18 colour tokens

All **[measured]**. `round-trip` is the hex recovered from the oklch value written into
`src/index.css`, not from the full-precision intermediate.

| token | hex | oklch | round-trip | bit-exact |
|---|---|---|---|---|
| `--color-thread-bg` | `#181818` | `oklch(0.2090 0 0)` | `#181818` | yes |
| `--color-sidebar-bg` | `#3a3b3b` | `oklch(0.3513 0.00137 197.09)` | `#3a3b3b` | yes |
| `--color-sidebar-hover` | `#434445` | `oklch(0.3861 0.00216 247.88)` | `#434445` | yes |
| `--color-sidebar-active` | `#494a4b` | `oklch(0.4085 0.00213 247.88)` | `#494a4b` | yes |
| `--color-sidebar-line` | `#4a4b4c` | `oklch(0.4122 0.00212 247.88)` | `#4a4b4c` | yes |
| `--color-rail-bg` | `#1f1f1f` | `oklch(0.2393 0 0)` | `#1f1f1f` | yes |
| `--color-surface` | `#212121` | `oklch(0.2478 0 0)` | `#212121` | yes |
| `--color-composer-bg` | `#2a2a2a` | `oklch(0.2850 0 0)` | `#2a2a2a` | yes |
| `--color-line` | `#3b3b3b` | `oklch(0.3523 0 0)` | `#3b3b3b` | yes |
| `--color-text` | `#ffffff` | `oklch(1.0000 0 0)` | `#ffffff` | yes |
| `--color-text-sidebar` | `#e1e1e1` | `oklch(0.9097 0 0)` | `#e1e1e1` | yes |
| `--color-text-muted` | `#848484` | `oklch(0.6133 0 0)` | `#848484` | yes |
| `--color-text-muted-side` † | `#a5a5a5` | `oklch(0.7219 0 0)` | `#a5a5a5` | yes |
| `--color-text-placeholder` | `#9a9a9a` | `oklch(0.6862 0 0)` | `#9a9a9a` | yes |
| `--color-accent` | `#ef8c57` | `oklch(0.7354 0.13858 47.76)` | `#ef8c57` | yes |
| `--color-ok` | `#5cc98c` | `oklch(0.7558 0.13470 156.47)` | `#5cc98c` | yes |
| `--color-bad` | `#ef6a63` | `oklch(0.6856 0.16581 25.41)` | `#ef6a63` | yes |
| `--color-on-solid` | `#181818` | `oklch(0.2090 0 0)` | `#181818` | yes |

**18 of 18 bit-exact.** The six values pre-computed in the W4-B work order
(`--thread-bg`, `--sidebar-bg`, `--text-muted`, `--accent`, `--ok`, `--bad`) reproduced
character-for-character, which is what licenses trusting the other twelve.

**† This table is 17 original values plus one owner-directed change — do not read all 18 as
sampled from the live app.** `--color-text-muted-side` was `#a3a3a3` when W4-B converted it and is
`#a5a5a5` as of 2026-09-03 (§4). Its conversion was re-derived from scratch after the bump, on the
same script and at the same rounding, and round-trips bit-exact like the rest **[measured]**. The
other 17 are the measured palette unchanged.

Three greys share a hue by construction: `--color-sidebar-hover`, `--color-sidebar-active` and
`--color-sidebar-line` all land on `247.88°` because they are near-neutral, and at `C ≈ 0.0021` the
hue is close to meaningless. That is expected, not a bug.

---

## 3. Structure of the emitted CSS

- **`@theme static`, not plain `@theme`.** `src/index.css` reads its tokens as raw `var(…)` in
  1,000-odd lines of hand-written rules, never through utility classes. Plain `@theme` emits only
  variables that some utility references, so it would delete every one of them and the app would
  render **unstyled with no error** (`docs/research/frontend-stack.md` §2.2 **[measured]**).
- **The 18 colours are renamed `--color-*`.** That prefix is the namespace that makes Tailwind
  generate `bg-accent` / `text-accent` / `border-accent`; a token named `--accent` inside `@theme`
  generates no utility at all (§2.3 **[measured]**). **87 `var()` references** in `src/index.css`
  were rewritten to match **[measured]**.
- **Rename completeness was proved, not assumed.** After the edit,
  `grep -oE 'var\(--[a-z-]+' src/index.css | sort -u` lists only `--color-*` names plus the five
  geometry values and the radius/font tokens; a grep for `var(--<old-name>)` across all 18 old
  names returns nothing **[measured]**. This mattered because a missed reference is an invisible
  unstyled element, not a build error.
- **The rename was safe to do textually.** `grep -cE 'var\(--[a-z-]+ *,' src/index.css` is `0`
  **[measured]** — no `var()` in the file uses a fallback — so `var(--name)` with its closing
  paren is an exact, unambiguous match. Without that check, `var(--text)` and `var(--text-muted)`
  would be a live prefix hazard.
- **Radii and fonts moved into `@theme static`**; they have real Tailwind namespaces
  (`--radius-*`, `--font-*`).
- **Five geometry values stayed in a plain `:root`**: `--sidebar-w`, `--row-h`, `--thread-max`,
  `--content-max`, `--feed-row-h`. No utility namespace fits a sidebar width, and Tailwind rewrites
  nothing outside `@theme`. They keep their original names.
- **`color-scheme: dark` stays on `:root`.** Tailwind does not set it, and it is what makes native
  controls and scrollbars dark.
- **No `@custom-variant dark` and no light token set**, per §2.4: with no `@custom-variant`
  anywhere, Tailwind 4's `dark:` already defaults to `@media (prefers-color-scheme: dark)`, so
  declaring the variant and never using it is misleading dead weight. `npx shadcn init` was **not**
  run, because it writes exactly that line plus a `.dark { … }` block.

The token count is unchanged: `grep -cE '^\s*--[a-z-]+:' src/index.css` is **28** before and after
**[measured]** — 18 colours, 5 geometry, 3 radii, 2 fonts.

### Two things found in passing, not fixed

- **`--content-max: 712px` is defined and never referenced.** `grep -n "content-max"
  src/index.css` returns exactly one line, its own definition **[measured]**. It is either dead or
  a rule that was never written. Left in place and annotated; deleting a measured value is a design
  call.
- **Two raw hex literals survive outside the token block**: `accent-color: #6f6f6f`
  (`src/index.css:137`) and `color: #d4d4d4` in `.col-l` (`:623`) **[measured]**. Neither was ever
  a token, so neither was in this conversion's scope. They are candidates for tokenising later.

---

## 4. Contrast, re-derived — including one AA failure

Every pair was recomputed **from the oklch values actually written into the file**, not from the
source hex, which is the only version of the check that can catch a rounding error. `recorded` is
`docs/research/frontend-stack.md` §2.6.

| foreground | background | recorded | from hex | re-derived from oklch | delta | AA (≥ 4.5) |
|---|---|---|---|---|---|---|
| `--color-text-muted` | `--color-thread-bg` | 4.748 | 4.748 | 4.747 | 0.0010 | pass |
| `--color-text-muted-side` ‡ | `--color-sidebar-bg` | 4.455 | 4.455 | **4.456** | 0.0014 | **FAIL** |
| `--color-text-placeholder` | `--color-composer-bg` | 5.101 | 5.101 | 5.101 | 0.0003 | pass |
| `--color-text` | `--color-thread-bg` | 17.756 | 17.756 | 17.758 | 0.0017 | pass |
| `--color-text-sidebar` | `--color-sidebar-bg` | 8.594 | 8.594 | 8.594 | 0.0003 | pass |
| `--color-accent` | `--color-thread-bg` | 7.237 | 7.237 | 7.239 | 0.0016 | pass |
| `--color-ok` | `--color-thread-bg` | 8.615 | 8.615 | 8.615 | 0.0000 | pass |
| `--color-bad` | `--color-thread-bg` | 5.844 | 5.844 | 5.845 | 0.0006 | pass |

All **[measured]**. Worst delta **0.0017**, against a 0.003 tolerance. `from hex` matches
`recorded` to three decimals on all eight, which confirms the script agrees with whatever produced
§2.6 independently.

**‡ That row is the pre-bump snapshot and is kept deliberately.** It is the measurement that
caught the AA failure, and this table's job is to show that the conversion reproduced the recorded
ratios — including the one that turned out to be wrong. The token shipping today is `#a5a5a5` at
**4.563:1, passing**; the row above describes `#a3a3a3`. Every other row is current.

### CLOSED: `--text-muted-side` failed AA and the owner bumped it

**The finding.** `#a3a3a3` on `#3a3b3b` is **4.4551:1** from hex, **4.4564:1** from the oklch it
converted to **[measured]**. WCAG AA for normal text is 4.5:1. It missed by **0.044**.

**Why this is the most useful paragraph in the file.** That token was tagged `[contrast]` — the
tag means *this value deliberately departs from the measured reference because the measured colour
fails AA*. Somebody had already noticed the problem and already lightened the colour once,
specifically to fix it. They lightened it from `#848484` (3.005:1) to `#a3a3a3` and stopped one
step short, and the comment beside it recorded the outcome as *"this is 4.6:1"*. **The comment
asserted a pass; the arithmetic was a fail; and nobody caught it for as long as the comment was
trusted instead of recomputed.** It surfaced only because W4-B re-derived all eight annotated
pairs from scratch rather than carrying the recorded ratios forward. Two of the other three ratios
in that same comment block were also wrong (see below). A `[contrast]` tag is a claim that
something was checked, and this one was the least reliable line in the file precisely because it
looked like it had already been handled.

**The decision.** Not W4-B's to make: choosing a replacement colour is a design call on a palette
sampled from a reference app. It was put to the owner and left unchanged, with the CSS comment
corrected so the file stopped asserting something false. **The owner bumped it to `#a5a5a5` on
2026-09-03**, on the grounds that this is sidebar secondary text and one step lighter is visually
indistinguishable.

**The new value, re-derived independently rather than taken on anyone's word** — the suggestion
`#a5a5a5` originated in W4-B's own report as unverified arithmetic, so it was run back through the
same script that produced §2's table **[measured]**, 2026-09-03:

| | hex | oklch @ 4/5/2 | round-trip | vs `#3a3b3b` from hex | from oklch | AA |
|---|---|---|---|---|---|---|
| was | `#a3a3a3` | `oklch(0.7155 0 0)` | `#a3a3a3` exact | 4.455 | 4.456 | **fail** |
| **now** | `#a5a5a5` | `oklch(0.7219 0 0)` | `#a5a5a5` exact | **4.562** | **4.563** | **pass** |

Achromatic, so `C = 0` and the hue is meaningless, as expected. The gain is **+0.107** of contrast
ratio for a lightness step of **L 0.7155 → 0.7219**, +0.0065 — 0.65% of the L range, which is what
makes the owner's "visually indistinguishable" claim plausible. The rejected `#848484` re-derives
to **3.005:1** on the same run, matching what the CSS comment already said.

**What was not checked:** whether `#a5a5a5` still looks right against the reference screenshot.
That is the thing that actually decides a palette value, and it was not done — the owner's
judgement stands in for it. AA is arithmetic; "indistinguishable" is not.

**A note for anyone re-running the rounding sweep in §1:** at two decimals `#a3a3a3` and `#a5a5a5`
both collapse to L 0.72 and read as 4.5572:1 **[measured]** — coarse rounding cannot tell the
failing token from its fix. That is now the sharpest available illustration of why §1 ships 4/5/2,
and it replaces the older one in `src/index.css`'s header, which cited this token's since-corrected
failing ratio.

### Three comments were wrong, not one

All the following were verified against both the hex and the oklch values **[measured]**. In every
case **W4-B corrected the comment and left the colour alone**; one of the four colours was
subsequently changed by the owner, which is the second row and is covered in full above:

| token | comment claimed | actually |
|---|---|---|
| `--text-muted` | 4.6:1 on `--thread-bg` | **4.75:1** |
| `--text-muted-side` | 4.6:1 on `--sidebar-bg` | **4.46:1** (failed AA; owner bumped it to `#a5a5a5`, now 4.563:1) |
| `--text-muted-side` | rejected `#848484` is 3.1:1 on `--sidebar-bg` | **3.00:1** |
| `--text-placeholder` | rejected `#606060` is 2.9:1 on `--composer-bg` | **2.28:1** |

The two "rejected colour" figures do not affect the shipped design — both colours were rejected
either way, and by a wider margin than recorded. They are listed because they show the original
ratios were estimated rather than computed, which is the reason the whole set needed re-deriving.

---

## 5. Bundle size

All **[measured]**, `npm run build` on this machine, 2026-09-02.

| build | JS | CSS |
|---|---|---|
| baseline, before this change | 262.69 kB (gzip 82.88) | 12.69 kB (gzip 3.07) |
| this change, isolated on top of `HEAD` | **262.69 kB** (gzip 82.88) | **21.89 kB** (gzip 5.23) |
| the working tree as built — and the committed figure at `3e5c3fd` | 263.28 kB (gzip 83.15) | 21.89 kB (gzip 5.23) |

**JS is byte-identical.** `@tailwindcss/vite` is build-time only, exactly as
`docs/research/frontend-stack.md` §2.5 predicted.

Row three is 0.59 kB heavier only because two other work orders were in flight in the same tree and
had added `src/paint.ts` plus its import in `src/main.tsx` — 49 modules transformed against 48.
Row two isolates this order by building a clean `git archive HEAD` with only this order's files
copied in, and returns to 262.69 kB exactly **[measured]**. None of the JS delta is Tailwind's.

**CSS grows 9.20 kB**, and essentially all of it is Tailwind's preflight, which §2.5 measures at
~8.7 kB raw / ~2.4 kB gzip and calls the floor. This order's own token layer costs about
**+0.54 kB** on top of a bare `@import` (§6).

**The unmounted `ThemeProvider.tsx` costs zero CSS.** Tailwind's oxide scanner walks the
filesystem rather than the module graph, so a file merely existing under `src/` can add utilities;
§2.5 warns about this. Building the isolated tree with and without `src/providers/` produced the
**identical CSS asset hash**, `index-BuiLRu0v.css`, 21.89 kB both times **[measured]**. The file
contains no utility-class-shaped strings, so there was nothing for the scanner to find. The warning
is correct in general — it simply does not bite for this file. It bit somewhere else instead: §6.

---

## 6. The scanner reads the docs, and the docs became CSS

**This is the most reusable finding in this file, and it is a trap that will catch the next
order.**

`docs/research/frontend-stack.md` §2.5 warns that Tailwind's oxide scanner walks the filesystem
rather than the module graph, and illustrates it with unused component files under `src/`. The
warning understates the blast radius: **the scanner also reads Markdown.** It extracts candidate
strings from `docs/**/*.md` and turns any that look like utilities into real rules.

This file caused it. §3 above names `bg-accent`, `text-accent` and `border-accent` in prose while
explaining what the `--color-*` namespace is for. That prose alone emitted, into the shipped
bundle **[measured]**:

```
.bg-accent{background-color:var(--color-accent)}
.bg-accent\/50{background-color:#ef8c5780}
.bg-accent\/50{background-color:color-mix(in oklab,var(--color-accent) 50%,transparent)}
.border-accent{border-color:var(--color-accent)}
.border-thread-bg{border-color:var(--color-thread-bg)}
.bg-thread-bg{background-color:var(--color-thread-bg)}
.text-accent{color:var(--color-accent)}
.text-thread-bg{color:var(--color-thread-bg)}
```

Adding and removing this one file moved the bundle **23.02 kB ↔ 23.33 kB** **[measured]**.
Excluding the whole `docs/` tree dropped it to **21.89 kB** — so the repo's other docs were
leaking too, and the total cost of documentation-as-CSS was **1.44 kB of rules nothing renders**
**[measured]**.

**Fix, in `src/index.css`:**

```css
@source not "../docs";
```

Verified in the installed `tailwindcss@4.3.3` rather than assumed: `dist/lib.mjs` parses `@source`
with a `not ` prefix and an `inline(…)` form, requires quoted paths, and rejects a nested `@source`
or one with a body **[measured]**. Paths resolve relative to the CSS file, hence `../docs`. After
the change, `grep -cE '\.(bg|text|border)-(accent|thread-bg)' dist/assets/*.css` is **0**
**[measured]**.

The exclusion is deliberately narrow. Scoping the scanner positively — `@import "tailwindcss"
source("../src")` — would work today but would silently drop anything a later order puts outside
`src/`, and `index.html` has no `class=` attribute at all (`grep -cE 'class=' index.html` is `0`
**[measured]**) so nothing is lost either way. Excluding one known-bad directory fails safe;
whitelisting one directory fails silent.

**One side benefit: those emitted rules are a free confirmation of §2.3.** `--color-accent` really
does generate `bg-accent` / `text-accent` / `border-accent`, and the `bg-accent/50` pair shows
Tailwind emitting a hex fallback beside the `color-mix()` version. That is now measured in this
repo, not just in the research scratchpad.

### Correction: §2.5 was right, and I was wrong about it

An earlier pass of this file claimed §2.5's `21.21 kB` figure was "low by about 1 kB". **That was
my error and it is retracted.** Reproducing §2.5's exact scenario — a clean `git archive HEAD`,
this order's `package.json` and `vite.config.ts`, and `HEAD`'s untouched `index.css` with one
`@import` line prepended — built to **22.24 kB** **[measured]**, which is where the claim came
from. But that tree still contained `docs/`. Deleting `docs/` from it, which matches the shape of
the scratchpad §2.5 was actually measured in (a copy of `src/` plus dependencies, no docs tree),
built to **21.35 kB** **[measured]** against the recorded 21.21 kB — a 0.14 kB / 0.7% difference,
which is a match.

So the discrepancy I saw was the docs leak, not an error in the research. Recorded here rather
than quietly deleted, because the wrong intermediate number is what led to finding the real bug.

**Nothing in `docs/research/frontend-stack.md` §2 turned out to be wrong.** Confirmed against it
directly: the `@theme static` requirement (§2.2), the `--color-*` namespace requirement (§2.3),
the dark-only reasoning (§2.4), the "zero JS" claim (§2.5), the filesystem-scanner caution (§2.5,
which proved truer than its own example), and all eight contrast ratios (§2.6).

### This order's own CSS cost

**21.35 kB → 21.89 kB, +0.54 kB** for the token conversion, comparing like with like (both without
the docs leak). It decomposes as **[asserted]**, from the shape of the diff rather than a
controlled measurement:

- ~0.52 kB from the `--color-` prefix on 87 `var()` references (6 bytes each).
- ~0.13 kB from the same prefix on the 18 declarations.
- oklch values being longer strings than 7-character hex, offset against the hex comments the
  minifier strips.

`tailwindcss@4.3.3` and `@tailwindcss/vite@4.3.3` installed on npm 11.16.0 defaults with **no
`ERESOLVE`** and **no `--legacy-peer-deps`** **[measured]**, as §4 predicted — 12 packages added.
One small correction to that section: `npm` reported **two** packages with unapproved install
scripts, `esbuild@0.28.2` **and `fsevents@2.3.3`**, not `esbuild` alone. `fsevents` is a macOS-only
optional dependency and was already present before this change, so it is a reporting difference,
not a new install script.

---

## 7. Gates

`npm test` **0**, 60 tests in 3 files. `npx tsc --noEmit` **0**. `npm run build` **0**. All
**[measured]**, exit codes captured directly rather than through a pipe.

The suite was 27 tests before this wave; the other 18 above this order's own 15 come from a
concurrent order's `src/paint.test.ts`. Nothing regressed.

**That 60 is a snapshot of this order's own run, not the settled figure.** `src/paint.test.ts`
grew from 18 tests to 24 in a follow-up order minutes later, so the suite is **66** at `3e5c3fd`,
the commit this work landed in — 27 `feedStore.test.ts` + 24 `paint.test.ts` + this order's 15.
`docs/STATUS.md` §3 carries the settled number; if the two disagree, STATUS is right and this line
is a dated measurement kept because it is what was actually executed here.

---

## 8. What was NOT checked

- **Whether the app still looks right. This is the big one and it is not covered.** The build
  succeeds and the tokens are mathematically identical, but the app was never launched. Tailwind's
  **preflight is a global CSS reset** that this project has never had before, and it changes
  defaults for margins, headings, lists, `border-style`, form controls and images across every
  rule in the 1,059-line file. Nothing here can detect a layout shift it caused. The first person
  to run `npm run tauri dev` should expect to find something, and `src/index.css` already carries
  its own reset (`* { box-sizing }`, the `button/input/select/textarea` reset at `:80`, and the
  `input[type=checkbox]` carve-out at `:96`) which now sits **on top of** preflight rather than
  alone. Whether those two resets fight has not been established.
- **Nothing was compared against the reference screenshot.** The conversion is arithmetic; that
  the palette is still *right* rests entirely on `docs/plans/ui-restyle-notes.md`.
- **Perceptual equality beyond 8-bit sRGB.** Round-tripping proves the values are identical at
  8 bits per channel. On a wide-gamut or 10-bit display the browser interpolates oklch differently
  from hex, and that was not measured.
- **`@theme static` against a `color-mix()` opacity modifier.** `src/index.css` uses no
  `color-mix()` and no `bg-accent/50`-style modifier today (`grep -nE 'color-mix|oklab|oklch'`
  matched nothing before the edit **[measured]**), so the interaction is untested.
- **Any Tailwind utility class in the running app.** Nothing consumes the tokens as utilities yet.
  That the utilities are *generated* correctly is now measured here (§6), but no element has ever
  been rendered with one.
- **Whether `@source not "../docs"` has a downside.** It was verified to remove the phantom
  utilities and to leave the build green; it was not tested against a future order that puts a
  scannable source file inside `docs/`, which would then be ignored silently.
- **The Linux desktop-portal theme path** in `src/providers/ThemeProvider.tsx` — see §9.
- **`npm run tauri build`.** Not run here; the six-gate suite is the lead's. It has since been
  run by the lead at `3e5c3fd` — exit 0, producing a `.app` and a `.dmg` **[measured, not by me]**.
  That is a packaging proof, not a launch: see the first item above, which is still open.

---

## 9. `src/providers/ThemeProvider.tsx`

Taken from `janhq/jan`, `web-app/src/providers/ThemeProvider.tsx`, 79 lines, **Apache-2.0**,
fetched from `raw.githubusercontent.com` (not checked out locally). The attribution notice and
licence URL are at the top of the landed file; no Jan product name, mark or branding was carried
over.

**Telemetry check — clean [measured].** `docs/research/jan.md` §6 warns that Jan vendors
`posthog-js` and a Google Analytics injector in `web-app/vite.config.ts`, and that any file lifted
from Jan must be checked before it lands. The fetched file was read in full: it imports exactly
three things (`react`, `@/hooks/useTheme`, `@/lib/platform/utils`), and its only side effects are
`document.documentElement.classList`, `window.matchMedia`, and two Tauri `invoke` calls. **No
analytics import, no network call, nothing stripped.** The telemetry lives elsewhere in Jan's tree
and did not come along.

Three adaptations, each commented in the landed file:

1. **No zustand.** Jan's `useTheme` is a zustand store; this is React context plus `localStorage`
   under `brigadier.theme`, matching `src/fps.ts`'s `brigadier.fps`. Jan reads
   `useTheme.getState()` inside its listeners to dodge a commit race between the theme switcher
   and the portal event; the equivalent here is a ref, read for the same reason.
2. **No `IS_LINUX` define.** Jan's comes from a Vite `define`; adding one would need an ambient
   type declaration in a file this order does not own, so Linux is sniffed from the user agent.
3. **Every Tauri call is behind `isTauri()`** from `@tauri-apps/api/core`, matching
   `src/bridge.ts:153`, so the app runs under a plain `npm run dev` with no Tauri present.

**The Tauri branch is inert and must not be read as working.** No Rust code in `src-tauri/` emits
the `theme-changed` event, and neither `get_system_theme` nor `set_gtk_prefer_dark` exists as a
command. Building them was out of scope. The listener registers and never fires; the `invoke`
rejects into a `.catch`. **The Linux desktop-portal path has never been exercised, here or
anywhere in this repo.**

**It is not mounted.** `src/main.tsx` belongs to another order this wave; the shell order (W4-C)
mounts it. It is early code, not dead code.

**It currently has no visible effect.** brigadier is dark-only with one unconditional token set
and no `.dark { … }` overrides, so the `.dark` class it toggles changes nothing on screen. The
mechanism is carried because Linux is the declared second platform and it costs nothing.

**One measured surprise worth keeping.** **jsdom 30.0.1 does not implement `window.matchMedia` at
all** — `TypeError: window.matchMedia is not a function` **[measured]**, probed under
`vitest run`. Jan's code calls it unguarded. The landed version guards it, and
`src/providers/ThemeProvider.test.tsx` installs a controllable stub and also pins the un-stubbed
case. Any future test touching `prefers-color-scheme` in this repo will hit the same wall.

The test file is 15 tests **[measured]**, all on behaviour — what `useTheme()` reports and what is
persisted — never on markup, since the shell that will mount this must stay free to change. The
Tauri branch is **deliberately untested**: `isTauri()` is false under jsdom, the event has no
emitter, and a mock would only pin the mock.
