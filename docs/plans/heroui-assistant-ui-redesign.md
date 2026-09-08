# HeroUI + assistant-ui redesign

Approved in conversation on 2026-09-07. Full feature parity, including backend behavior, persistence, source control, session lifecycle, notes, trash and history.

- HeroUI v3 owns controls and the shell. assistant-ui owns conversation primitives and Elements widgets, adapted to HeroUI controls. Remove shadcn and Prompt Kit source and direct dependencies.
- Project/session sidebar left; conversation center; resizable, collapsible tools and document tabs right.
- Light, dark and system appearance. Neutral palette, blue accent; compact shell with more space for conversation.
- Routine activity is expandable, with the current action visible while running. Answers, questions, approvals and artifacts stay visible.
- Attention dot takes priority over a working spinner. Collapsed projects roll up session status. No separate waiting-on-you navigation item.
- Approvals belong to their conversation and retain all existing permission semantics.
- Preserve cinematic intro, music and transitions. Only its input changes to HeroUI.
- Keep Monaco and xterm.js, themed consistently.

Validation: TypeScript and production build, relevant existing and new behavioral tests, browser review in both themes and a narrow viewport. Verify streaming, persistence, focus/keyboard interaction, approvals, and no removed-library imports.

## Implementation

- `src/components/controls` composes HeroUI controls with existing app callbacks. The old `ui` and `prompt-kit` directories, registry config, and direct Radix/cmdk dependencies are removed.
- `src/components/assistant-ui/elements` contains adapted MIT registry components. Existing chat records are projected into an assistant-ui external-store runtime; approvals render inside their session's thread. Phase states, unknown outcomes, file navigation, permission suggestions, and provider errors retain their backend meaning.
- The conversation stays visible while workspace tabs open. Tool tabs support keyboard cycling, close/save confirmation, persistent buffers, and terminal lifetime across project switches. The right panel resizes on desktop and overlays at narrow widths; navigation uses a HeroUI Drawer on small screens.
- HeroUI theme tokens style the app. Monaco and xterm update with appearance changes. `Launch.tsx`, `launch.css`, intro assets, audio, and transitions are unchanged; `NameInput` uses HeroUI Input.

## Verification

Production build and TypeScript pass. The complete suite passes with 277 tests, including regression checks for Save As form submission and the current action remaining visible when live work is collapsed. The old CSS tests asserted the retired stylesheet's selectors and fixed pixel arithmetic; they were replaced by the UI dependency boundary check, updated behavioral tests, and browser layout review.

Browser preview checked light/dark appearance, the 800×500 desktop layout, the 600×700 navigation drawer, session navigation, expandable paired tool output, a simulated sent turn, and inline cross-project approvals with session/project attention dots. A clean reload recovered from the temporary context mismatch caused by formatting files during Vite hot reload. No new runtime errors appeared after that reload. Native Tauri agent execution and real PTY interaction were not exercised; their backend code is unchanged.

The production build still reports the large lazy-loaded Monaco bundle warning.

Native installation verified on 2026-09-08: `npm run tauri build -- --bundles app` passed, the bundle was ad-hoc signed and passed strict signature verification, and `/Applications/Brigadier.app` was replaced and relaunched. Native accessibility confirmed the redesigned controls and preserved projects and composer draft. The previous application and app data are backed up in `/Users/stephen/Library/Application Support/Brigadier-update-backups/20260908-000837-heroui-redesign`. Real agent execution and PTY interaction remain outside this launch check.
