# assistant-ui thread audit

Date: 2026-09-08. Scope: historical recommendation, no UI implementation.

**Superseded on 2026-09-09:** the owner chose standalone, props-driven Elements. See [the registry audit](assistant-ui-elements-2026-09-09.md) and [implemented composition](../plans/conversation-elements-2026-09-09.md). The connected Thread recommendation below records the earlier investigation and is not the current design.

## Recommendation

Adopt assistant-ui's connected Thread and message-part composition as the conversation foundation. Keep Brigadier's external runtime, session orchestration, and small domain-specific renderers for session links, provenance, approvals, file changes, and tool details. Replacing the outer container alone will not fix the current event projection.

## What the library provides

- **Connected Thread** is a runtime-backed composition of thread, message, composer, action-bar, and branch primitives. It has no standalone version. Its supported slots include `AssistantMessage`, `ToolFallback`, `ToolGroup`, and `ReasoningGroup`; per-tool renderers can replace individual tool views. Components install as editable source, so using them still means owning their styling and integrations. [Thread documentation](https://www.assistant-ui.com/elements/thread)
- **Elements has both runtime and standalone components.** For example, Reasoning can consume runtime reasoning parts or accept content and streaming state through props. The standalone version is disclosure UI over supplied content, not an event interpreter. The runtime composition groups adjacent reasoning parts with `MessagePrimitive.GroupedParts`. It cannot provide reasoning that the provider did not send. [Reasoning documentation](https://www.assistant-ui.com/elements/reasoning)
- **Tool Group** wraps consecutive calls and derives its running state from those calls. **Tool Timeline** summarizes a message's calls as steps, targets, and file statistics. The latter is useful visual inspiration, but Brigadier must supply meaningful mappings for its own tool names and results. [Tool Group](https://www.assistant-ui.com/elements/tool-group), [Tool Timeline](https://www.assistant-ui.com/elements/tool-timeline)
- **GroupedParts** supports adjacent groups, including nested grouping paths. Preserve normal text as ungrouped leaves so visible progress prose remains between activity groups. The documentation recommends this API over `Unstable_PartsGrouped` for ordinary consecutive reasoning/tool grouping. [Message Part Grouping](https://www.assistant-ui.com/docs/guides/part-grouping)
- **ExternalStoreRuntime remains appropriate:** Brigadier owns persistent state and execution; the adapter translates it into assistant-ui's message format. Features depend on the callbacks/capabilities provided. A UI migration does not require adopting a new backend or assistant-ui Cloud. [ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)

## Current code and compatibility

The lockfile resolves `@assistant-ui/react` 0.15.18, `@assistant-ui/core` 0.3.17, and `@assistant-ui/react-markdown` 0.14.14. The installed React package already exports `MessagePrimitive.GroupedParts` and `groupPartByType`; this recommendation does not depend on upgrading for those APIs. Verify newly copied registry component imports against these pinned versions during implementation.

Local source evidence:

- `src/components/ThreadView.tsx` already uses `useExternalStoreRuntime`, `ThreadPrimitive`, and `MessagePrimitive`. However, it converts activity into placeholder text plus custom metadata and renders `WorkTrace` instead of structured message parts.
- `src/components/assistant-ui/elements/thread.tsx` and `reasoning.tsx` are already adapted assistant-ui source. The problem is the composition and integration, not simply absence of the library.
- `src/threadProjection.ts` promotes only trailing assistant prose to a visible answer after completion, hiding earlier progress prose inside the work block.
- The main audit found empty thinking disclosures, unconditional copy actions on trace text, and native button alignment/padding responsible for the centered, widely spaced activity rows.
- Installed upstream `node_modules/@assistant-ui/core/src/react/primitives/message/MessageGroupedParts.tsx` supports a synthetic running indicator and adjacent grouping. A renderer must handle each leaf explicitly; `children` belongs only to groups. Preserve the existing startup-placeholder regression coverage when replacing the renderer.

## Migration boundary

First translate saved/live events into chronological text, reasoning, and tool-call parts, pairing results by tool-call ID and preserving stable identities. Filter empty completed reasoning; show a compact live status while waiting. Then use connected message rendering, compact activity groups, and standard action behavior. Keep short clickable peer attribution and Brigadier's native tool/approval actions as small overrides. Validate streaming, reload, cancellation, failures, and session switching with real-runtime fixtures and visual checks against the supplied screenshots.
