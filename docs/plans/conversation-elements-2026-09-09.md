# Conversation Elements implementation

The conversation uses assistant-ui's editable standalone Chat Panel, Tool Call, Reasoning Panel, Thinking Indicator and Message Actions Elements. The component/dependency decision is documented in [the registry audit](../research/assistant-ui-elements-2026-09-09.md).

## Behavior

- Main-session prose appears chronologically between adjacent activity groups, during execution and after completion. Pairing still runs across the whole turn so late results and explicitly parented child activity remain inspectable.
- Empty provider reasoning is omitted; actual reasoning remains expandable. One compact Working indicator represents a live session. Unknown or interrupted calls do not receive success checkmarks; failed calls remain visibly marked.
- User bubbles, short clickable peer attribution, hover/focus message actions, raw tool details, child session links, file links and final changed-file cards use existing Brigadier handlers.
- The existing assistant-ui runtime handles viewport scrolling and Markdown context. Saved rows render directly through standalone Elements, so synthetic startup messages cannot enter the Brigadier renderer. The real composer, pending submissions, error recovery and native execution are unchanged.

## Registry ownership

`components.json` records the style-aware registry. Installation used:

```sh
npx shadcn@latest add @assistant-ui/elements-chat-panel @assistant-ui/elements-tool-call @assistant-ui/elements-reasoning-panel @assistant-ui/elements-message-actions @assistant-ui/elements-thinking-indicator --yes --overwrite
```

The CLI installed `radix-ui` 1.6.7 and `tw-shimmer` 0.4.12, plus editable Collapsible, surfaces and range source. It emitted surface/range helpers under `src/lib`; local imports were corrected to that location. Re-adding with overwrite will replace the documented local changes: Brigadier palette, full conversation sizing, Markdown-compatible wrappers, Radix state/animation attributes, optional supported actions, explicit tool outcomes and nested detail slots. CSS is scoped in `elements.css`; `App.tsx`, `index.css`, bridge/workspace APIs and Rust source were not edited.

## Verification (measured)

- `npm test`: **387 passed** across 43 files. Added chronology, stable identities, empty/real reasoning, startup, failure/interruption, unknown tool outcomes, keyboard disclosures, file/edit actions, peer attribution, paginated history, restored disclosures and stale session-load coverage.
- `cargo test --workspace`: **670 passed, 8 ignored**, zero failures.
- `npm run build`: passed. Existing VS Code browser-externalization and large-chunk warnings remain.
- `tauri build --debug --bundles app` with a temporary config: passed, producing `target/debug/bundle/macos/Brigadier Chat Preview.app`. The temporary config uses identifier `ai.brigadier.chat-preview`, separate app data and the built frontend. It did not replace `/Applications/Brigadier.app`.
- Browser UI at port 1422: inspected prose/activity ordering, provider reasoning, nested agent details, raw command results, restored expansion after reload, scrolling and hover actions. No browser console errors. Row left edges measured equal; closed activity rows measured 26px, with 14px between activity blocks and the next message.
- Native preview: application and onboarding rendered. The macOS folder picker did not respond reliably through computer control; **a live native conversation was not verified in this task**. Native execution and peer coordination were not changed.

Review image: `/Users/stephen/.codex/visualizations/2026/09/08/01a082d2-833d-7091-b00e-0a6be0856f42/brigadier-elements-preview.png` (browser fixture, visibly marked as simulated).

## Integration

This change is isolated in worktree `a91f`. Integrate its diff/commit without copying uncommitted work from the other workbench task. The original checkout and installed application were not updated.
