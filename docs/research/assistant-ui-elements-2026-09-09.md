# Brigadier conversation Elements audit

Verified against the official documentation and downloaded registry source on 2026-09-09. This supersedes the earlier audit's recommendation to adopt the connected Thread as the visible composition.

Use editable, props-driven Elements for the conversation: `ChatPanel` message pieces, `ToolCall`, `ReasoningPanel`, `MessageActions`, and `ThinkingIndicator`. Wire them to Brigadier's event projection and callbacks. These specific registry sources contain no assistant-ui runtime imports. Keep the existing runtime where it still supplies scrolling or Markdown context; a runtime is not a requirement of these visual components. The [official index](https://www.assistant-ui.com/llms.txt) distinguishes the Elements catalog from the runtime and primitive references.

## Verified dependency graph

The table reports each item's declared dependencies, followed by the relevant transitive registry requirements. React, Tailwind, and the project's `cn` utility remain application prerequisites.

| Registry item | Direct npm dependencies | Registry dependencies | Runtime requirement |
| --- | --- | --- | --- |
| [elements-chat-panel](https://r.assistant-ui.com/elements-chat-panel.json) | `lucide-react` | `elements-surfaces` | None |
| [elements-tool-call](https://r.assistant-ui.com/elements-tool-call.json) | `lucide-react` | `elements-surfaces`, shadcn `collapsible` | None |
| [elements-reasoning-panel](https://r.assistant-ui.com/elements-reasoning-panel.json) | `lucide-react` | `elements-surfaces`, `elements-range`, shadcn `collapsible` | None |
| [elements-message-actions](https://r.assistant-ui.com/elements-message-actions.json) | `lucide-react` | `elements-surfaces` | None |
| [elements-thinking-indicator](https://r.assistant-ui.com/elements-thinking-indicator.json) | None declared | `elements-surfaces` | None |
| [elements-surfaces](https://r.assistant-ui.com/elements-surfaces.json) | `tw-shimmer` | None | None |
| [elements-range](https://r.assistant-ui.com/elements-range.json) | None declared | None | None |

`elements-surfaces` also declares the stylesheet addition `@import "tw-shimmer"`. Its `ShimmerLabel` uses the `shimmer` class; `SwapLabel` uses React layout effects and `ResizeObserver`. `elements-range` installs a small TypeScript utility module; `ReasoningPanel` imports its `take` function to clamp the visible step count. It is not an npm package. The [tw-shimmer documentation](https://www.assistant-ui.com/docs/utilities/tw-shimmer) confirms that the package is a CSS-only Tailwind v4 plugin with no dependencies.

`collapsible` is flavor-dependent. The [new-york registry](https://ui.shadcn.com/r/styles/new-york/collapsible.json) declares `@radix-ui/react-collapsible`; the [base-nova source](https://ui.shadcn.com/r/styles/base-nova/collapsible.json) imports `@base-ui/react/collapsible`. The actual shadcn CLI installation in this worktree imports `Collapsible` from `radix-ui` and added that umbrella package as a direct dependency (1.6.7 resolved). This supersedes the earlier blanket ban on Radix/shadcn dependencies, following the owner's request. The current `cn` helper uses existing `clsx` and `tailwind-merge` packages. No migration to Base UI is necessary.

## Standalone and connected components are different choices

The official [Thread documentation](https://www.assistant-ui.com/elements/thread) explicitly says Thread has no standalone build and needs an `AssistantRuntimeProvider`. Its [registry](https://r.assistant-ui.com/thread.json) installs `thread.aui.tsx`, directly depends on `@assistant-ui/react` and `lucide-react`, and pulls in button, skeleton, attachment, file, follow-up suggestions, image, Markdown, reasoning, tooltip-icon-button, tool-fallback, and tool-group registry items. That is not the dependency graph of the five standalone Elements above.

The [Chat panel documentation](https://www.assistant-ui.com/elements/chat-panel) explicitly supports composing its pieces from application-owned messages. It also documents `ThreadPrimitive.Viewport asChild` around `ChatPanelMessages`, allowing the runtime to own scrolling while the installed Element owns the appearance. This is a suitable way to preserve existing scroll behavior without rebuilding the visible Elements from primitives.

## Required local adaptations

1. **Conversation layout:** The shipped ChatPanel is a 270px demo card with `max-w-md`; its messages use `justify-end`, and assistant text is a small `<p>`. Override the card dimensions and spacing for the full conversation, and change the assistant wrapper to `<div>` before placing Markdown blocks inside it. Its composer displays a placeholder `<span>` and has no input value. Preserve Brigadier's working composer and its edit/send/stop/pending behavior. These limits are visible in the [source](https://r.assistant-ui.com/elements-chat-panel.json).
2. **Tool outcomes and details:** The shipped ToolCall accepts string request/result fields and a `running` boolean; every non-running call gets a green check. Extend the editable copy with explicit outcome handling and a details slot so failed, cancelled, awaiting-approval, and unknown-completion calls are not reported as successful. Preserve expandable request/output, file links, child sessions, and approval actions. Keep the registry's compact disclosure and styling. See the [source](https://r.assistant-ui.com/elements-tool-call.json) and [component docs](https://www.assistant-ui.com/elements/tool-call).
3. **Reasoning:** ReasoningPanel is the static step-list design, driven by `steps`, `visibleSteps`, `streaming`, and controlled open state. It is not the connected Markdown reasoning renderer. Feed it only actual provider reasoning; a neutral title can label a real text block, but do not manufacture intermediate steps. Omit empty completed panels. For a live run with no reasoning or active tool to show, render one ThinkingIndicator. See [Reasoning](https://www.assistant-ui.com/elements/reasoning) and [Thinking indicator](https://www.assistant-ui.com/elements/thinking-indicator).
4. **Actions:** The registry MessageActions requires callbacks for copy, feedback, regenerate, and more, and always renders those buttons. Make unsupported callbacks optional and gate their buttons. Show copy only when actual response text exists, with unobtrusive hover/focus visibility; do not install no-op feedback/regenerate controls. See [source](https://r.assistant-ui.com/elements-message-actions.json) and [docs](https://www.assistant-ui.com/elements/message-actions).
5. **Collapsible compatibility:** The downloaded standalone `surfaces` source uses `--collapsible-panel-height` and Base UI starting/ending attributes; ToolCall and ReasoningPanel chevrons use open/panel-open attributes. Brigadier's Radix wrapper exposes `data-state="open"` and `--radix-collapsible-content-height`. Adapt the local animation/state classes to those actual attributes and visually test both open and closed states. [Radix's API](https://www.radix-ui.com/primitives/docs/components/collapsible) documents them. Although the [assistant-ui flavor guide](https://www.assistant-ui.com/docs/base-ui) describes shared compatibility for the connected kit, the specific standalone registry source still needs this inspection.

Keep `@assistant-ui/react-markdown` while `MarkdownText` imports it, and `@assistant-ui/react` while Markdown uses `TextMessagePartProvider` or the conversation retains runtime viewport behavior. The installed Markdown package also declares an assistant-ui React peer dependency. Removing either solely because the newly selected Elements are standalone would break existing consumers.

Verification should cover chronological prose–tool–prose rendering, empty reasoning, synthetic runtime startup messages, terminal failure/cancel states, disclosure behavior, switching/reload/history loading, and scrolling while expanded details change height. Registry defaults are a starting point; they do not supply Brigadier's event semantics.
