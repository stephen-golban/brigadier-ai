# UI restyle: brigadier shaped like the ChatGPT macOS app

Date: 2026-09-02. Scope: `src/**` only. This is a restyle, not a feature change: nothing the
window used to show was dropped, several things moved.

Tags: **[measured]** sampled out of a screenshot taken on this machine today ·
**[derived]** interpolated from measured values · **[not checked]** exactly that.

## 1. Source of truth

A real screenshot of the installed app, not a reference or a memory of one.

- App: `/Applications/ChatGPT.app`, version **26.825.51511**, in its **Codex** view (the view it
  opens on for this user). Native Swift, no CSS to read.
- Method: `open -a ChatGPT`; window id from `CGWindowListCopyWindowInfo` via a one-file Swift
  script; `screencapture -x -l <id>`; the resulting 3680x2260 PNG (window plus its shadow, 2x
  device pixels, 56pt of shadow padding on every side) sampled with Pillow.
- The app was never signed into, typed into, or configured. It was quit afterwards.
- Screenshots live in this session's scratch directory and are **not** checked in:
  `chatgpt.png` (system Dark) and `chatgpt-light.png` (system Light). The method above
  reproduces them in about a minute.

**The reference is dark only.** It was captured under both system appearances. The thread stayed
`#181818` in both; only the sidebar changed, and it changed because the window had moved to
another display with a different desktop behind its translucent sidebar material, not because the
app followed the appearance. So `src/index.css` ships one dark scheme and no
`prefers-color-scheme: light` block. **[measured]**

One caveat that cannot be designed around from `src/**`: the reference's sidebar is a native
`NSVisualEffectView`, so its colour depends on the user's wallpaper. `#3a3b3b` is what it read on
the built-in display; the same sidebar read `#222222` over a different desktop. A webview cannot
reproduce vibrancy without a window-level change in `src-tauri`, which this change does not own,
so the token is an opaque approximation of the value observed on the primary display.

## 2. Token table

Everything is a CSS custom property at the top of `src/index.css`.

| Token | Value | Source |
|---|---|---|
| `--thread-bg` | `#181818` | [measured] main conversation area |
| `--sidebar-bg` | `#3a3b3b` | [measured] sidebar, primary display (see caveat above) |
| `--sidebar-hover` | `#434445` | [derived] halfway between sidebar and selected |
| `--sidebar-active` | `#494a4b` | [measured] selected row pill |
| `--sidebar-line` | `#4a4b4c` | [measured] the 1px rule above the account row |
| `--rail-bg` | `#1f1f1f` | [measured] strip behind the composer's context tabs |
| `--surface` | `#212121` | [derived] card fill, between rail and composer |
| `--composer-bg` | `#2a2a2a` | [measured] composer input box |
| `--line` | `#3b3b3b` | [measured] 1px border on the thread's suggestion cards |
| `--text` | `#ffffff` | [measured] |
| `--text-sidebar` | `#e1e1e1` | [measured] sidebar row label |
| `--text-muted` | `#848484` | [measured] section labels; 4.6:1 on `--thread-bg`, passes AA |
| `--text-muted-side` | `#a3a3a3` | **departure**: `#848484` is 3.1:1 on the sidebar, this is 4.6:1 |
| `--text-placeholder` | `#9a9a9a` | **departure**: the measured `#606060` is 2.9:1 on the composer |
| `--accent` | `#ef8c57` | [measured] the composer's "Full access" chip; 5.6:1 on the composer |
| `--ok` / `--bad` | `#5cc98c` / `#ef6a63` | [derived] the reference has no green and no red |
| `--on-solid` | `#181818` | [measured] glyph inside the white send button |

| Geometry | Value | Source |
|---|---|---|
| `--sidebar-w` | `276px` | [measured] 275.5 |
| `--row-h` | `30px` | [measured] sidebar row pitch and pill height |
| `--radius-row` | `8px` | [measured] pill corner arc, 16 device px |
| `--radius-md` | `12px` | [measured] thread card corner |
| `--radius-lg` | `20px` | [measured] composer corner |
| `--thread-max` | `736px` | [measured] composer box width |
| `--content-max` | `712px` | [measured] context strip and suggestion-card row |
| pill inset | `8px` each side | [measured] |
| icon column | 16px glyph at 16px from the edge, label at 41px | [measured] |
| group gap | `8px` extra between projects | [measured] 39px pitch vs 31.5px |
| account bar | 46px tall, 1px top rule | [measured] |

| Type | Value | Source |
|---|---|---|
| stack | `-apple-system, BlinkMacSystemFont, "SF Pro Text", …` | the reference is SF Pro |
| sidebar row | 14px | [measured] cap-plus-descender 12.5pt |
| section label | 12px, sentence case (not uppercase) | [measured] |
| sidebar title | 17px / 700 | [measured] |
| empty-state headline | 24px / 600 | [measured] 24.5pt ink height |
| feed row | 12px mono, 18px row | unchanged from before the restyle |

## 3. What moved where

| Harness information | Before | Now |
|---|---|---|
| Projects | left pane, one bordered block each | sidebar rows under a "Projects" label, folder glyph, ChatGPT's own shape |
| Sessions | nested list, only under the selected project | same, indented to align with the project label; short id, status dot, cost |
| Session cost | trailing `.cost` span | `.side-meta` trailing slot, unchanged text |
| Project root path | muted line under the project name | `title` on the project row, and spelled out in the thread's top strip |
| Pending approvals per project | `badge` in the project row | `.chip` in the same trailing slot, plus a sidebar "Approvals" row with the total |
| `probe_claude` result | banner in the window header | sidebar bottom bar, where the reference puts its account row |
| `run_id` / version / mock flag | window header | second line of that same bottom bar |
| Error notice | window header | pill in the thread's top strip, still click-to-dismiss |
| FPS meter | window header | thread top strip, right side, still in flow above the feed |
| Feed | centre pane, full width | thread column, centred on 736px, same virtualizer, same row markup |
| Feed row count | pane header | small mono label in a 15px band above the scroller |
| "no rows yet" | one grey line | centred empty state: mark, "What should we run in `<project>`?", one line of help |
| Approvals | right rail | cards docked above the composer inside the thread column, hidden when empty |
| Approval "other project" marker | inline style | `.approval.elsewhere`, a 2px accent left border |
| New session form | right rail | the composer itself, whenever no session is selected |
| Composer send / interrupt / end / kill | four equal buttons | one white circular send button plus three flat pill actions, all still reachable |
| Session usage line | under the composer | same place, mono, 11px |
| Add project | form at the sidebar foot | "+" on the "Projects" section header, revealing the same path input |
| Burn (dev) | right rail panel | collapsed `<details>` in the sidebar, above the status bar |

## 4. Room left for the next change

- **Resume button**: `.dock-actions` in both `Composer.tsx` and `NewSession.tsx` has an explicit
  secondary-action slot, a `<span className="grow" />` with a comment on it. A `<button
  className="act">Resume</button>` placed before that span lands beside the status chip, on the
  left of the row, exactly where the reference puts its own secondary controls.
- **Branch name on a session row**: `.side-meta` is a flex row and already holds the cost, so a
  `<span className="chip plain">main</span>` fits beside it with no layout change. If the branch
  wants its own line instead, `.side-sub` is defined and unused; a session row then becomes a
  two-line row and only its `min-height` needs raising.

## 5. Gates

`npx tsc --noEmit` and `npm run build` are green on the final source.

`npm run tauri build` was green earlier in this session and produced
`target/release/bundle/macos/brigadier.app`, which is what
`docs/plans/ui-2026-09-02.png` was captured from. A later re-run of the same command failed in
`crates/supervisor/src/lib.rs` (first `E0063: missing field generation in initializer of
LiveSession`, then `E0061` on a retry a minute later), which is a Rust crate another worker was
editing at the time, not front-end code. The only front-end change made after the last green
bundle is one button label, `jump to latest` to `Jump to latest`, in `src/components/Feed.tsx`.

## 6. What was not checked

- **The feed gate was not re-run.** `docs/research/feed-rendering.md` §4's burn was not executed
  after the restyle, so "no regression" is asserted, not measured. What is true by construction:
  `Feed.tsx`'s row markup is unchanged (one `div` plus three or four `span`s, the same nodes as
  before), `ROW_H` is still 18, `estimateSize` still returns it, `measureElement` is still never
  called, and `anchorTo`/`followOnAppend`/`useFlushSync: false` are untouched. The row's CSS
  gained a mono `font-family` and an explicit `line-height`, and `.feed-sizer` gained
  `max-width` plus `margin: 0 auto`. Two new elements sit outside the scroller's containment and
  re-render with the feed: `.feed-count` (one text node) and `.thread-empty` (rendered only when
  there are zero rows, so never during a burn).
- **Light appearance**: no light scheme exists, because the reference has none. If the owner wants
  one it has to be designed, not measured.
- **Vibrancy**: the sidebar is a flat colour, not a translucent material. Matching that needs a
  `src-tauri` window change.
- **Title bar**: the reference hides its title bar and runs the sidebar to the top of the window.
  `src-tauri/tauri.conf.json` is outside this change, so brigadier keeps the native title bar and
  the sidebar starts below it.
- **Icons**: the reference uses a real icon set. No library was added (the brief forbids one), so
  the glyphs are single Unicode characters. They are the least faithful part of the restyle.
- **The dev-only burn panel was not seen.** It compiles, but `import.meta.env.DEV` keeps it out of
  the release bundle that was screenshotted, and no dev build was rendered (headless Chrome could
  not paint on this machine: `CVDisplayLinkCreateWithCGDisplay failed`, and `--virtual-time-budget`
  never expires against the mock's endless rAF loop).
- **The approvals dock was not seen with a card in it.** No approval was pending in the store while
  the app was open, and none was manufactured.
- Nothing was tested on Windows or Linux, at any window width below the 800px minimum, or with a
  screen reader.

The screenshot `docs/plans/ui-2026-09-02.png` is the built app with the `burn` project's first
session selected, reached by pressing the sidebar buttons through the accessibility API. Nothing
was typed into the app and no session was started; `feed_tail` on an already-exited session is a
read out of SQLite and spends nothing.
