# Brigadier composer redesign — interview decisions

Status: approved by the owner on 2026-09-09. The owner confirmed the consolidated design and requested a new project task to implement the entire work. This spec records the current composer interview and supersedes conflicting older composer guidance. It does not authorize deployment or unrelated architecture changes.

## Product foundation

The composer addresses a durable Brigadier task. Rust owns the task's goal, decisions, progress, results, verification, sources and displayed conversation. Provider executions and workspaces are separate resources. Both Auto and Custom retain Brigadier orchestration: decomposition, delegation, independent review/fusion, integration and verified delivery. Custom is not a conventional accumulating provider-chat mode.

Do not build the experience around a filling lifetime-context window, routine transcript compaction or relay handoffs. A provider change changes execution configuration within the same task; it does not promise copying the complete displayed transcript between providers. Relevant saved task state must support continued execution.

Source precedence and implementation gaps are recorded in [architecture research](../research/composer-architecture-research-2026-09-09.md). In particular, the existing interactive path's native-session reuse is not proof that it already satisfies the intended disposable/bounded execution architecture. Do not represent checkpoint injection alone as that guarantee.

## New task and mode lifecycle

- A new task inherits the project from which New session was invoked. Auto does not choose a different project from the prompt.
- A project without saved preferences starts in **Auto + Approve for me**.
- Auto chooses routine environment/worktree, branch, provider, model and effort settings. First Send starts immediately, with brief preparation feedback; there is no mandatory setup-approval gate.
- Permissions always remain an explicit user-controlled setting.
- Before the first send, Custom exposes project, environment/worktree and branch pickers in an inset upper rail. Permissions remain on the input's lower left. The provider/model/effort control sits on the lower right.
- Custom gives manual control over the orchestrator's provider, model and effort. Workers independently choose suitable connected provider/model/effort settings within task permissions and shared limits.
- Once started, the task's project, branch and environment/worktree are locked. This does not prevent Brigadier from isolating delegated work in separate worker workspaces.
- A task started in Custom cannot switch to Auto. A running Auto task can switch to Custom as a one-way takeover, inheriting its effective settings.
- Auto may adapt model and effort between turns. Its trigger continues to say Auto, with effective execution settings inspectable.
- In Custom, provider/model/effort and permissions remain manually adjustable for subsequent work. A configuration change does not alter the provider of an already-running response.
- After starting, remove the upper setup rail. Locked setup details remain available in the context card; do not leave disabled setup pickers consuming composer space.

## Remembered project preferences

Persist each project's last mode, permissions, manual provider/model/effort, environment/worktree and branch selections across app restarts. Manual changes during an existing task update that project's preferences for future tasks. Existing tasks retain their own settings.

Keep saved Custom choices separate from Auto's computed execution choices; automatic routing must not overwrite the user's manual preferences. If a remembered branch, provider or model becomes unavailable, make the condition visible during setup rather than silently claiming the missing choice is applied.

## Combined provider/model/effort popover

Use the reference effort-slider card as the visual base for one unified popover:

1. Provider selector at the top.
2. The selected provider's models in the middle, with a checkmark on the selected model.
3. The selected effort label and stepped slider at the bottom, using only that model's supported values.

Changing a provider/model updates the contents inside this same popover. Selecting a model keeps it open for effort adjustment; clicking outside closes it. The Custom trigger is compact: provider icon, model name, effort. Use real connected capabilities and actual model catalogs.

A provider change produces a subtle inline divider with provider icon and text such as “Switched to Codex”; details are available on click. Adapt assistant-ui's day-separator visual treatment within the rich conversation. Do not flatten the transcript into the standalone day-separator's text-only history renderer.

## Input, attachments, references and commands

- No voice mode, microphone or dictation controls in this version; deferred for the future.
- No formatting, note or mention toolbar buttons. Formatting and references are handled while typing.
- The + button opens the file picker directly. Also support image paste and file drag/drop through the same durable attachment pipeline.
- Stage images as thumbnails and other files as chips inside the composer, with per-file progress, retry and removal. Send remains disabled while any retained attachment is not ready.
- Preserve existing rich-input capabilities, code/path whitespace, IME, undo, durable draft/reference/attachment identity and large-paste handling. This redesign is not authorization to remove previously approved working features.
- Typing @ opens one menu above the input with files, notes and agent sessions grouped by type and filtered as the user types. Prioritize the current project and include global notes. Insert a compact inline reference chip backed by a real stable reference. No separate mention/notes button.
- Slash-command selection stages the command. Enter while the suggestion menu is open selects the highlighted command; a subsequent Enter submits it. Argument-bearing commands leave the cursor ready for arguments.
- Discover real supported commands and implement actual execution. An assistant-ui trigger popover is not itself a provider command implementation. Existing `/compact` exposure must not be treated as an intended Brigadier lifecycle requirement.

## Queue, stop and continuation

- Enter while work is running queues the message by default. Show queued messages above the input with Edit, Remove and Steer now.
- Steer now explicitly delivers to active work. Implement a genuine compatible execution path; do not label ordinary delayed queueing as steering.
- In Custom, queued messages retain the provider/model/effort settings captured when queued; editing permits changing those settings. In Auto, resolve execution choices when the queued message runs, using current task state.
- Keep Stop available while the user composes. Preserve the established task-level Stop contract: durably pause dispatch and retries, cancel owned active work/descendants, show Stopping then Stopped, retain partial work and queued content, and require explicit Continue. Do not auto-restart after Stop.
- Preserve acknowledged-delivery semantics, stable request IDs and uncertain-outcome recovery. Never remove a queued message solely because the UI sent a request.

## Permissions, fusion and approvals

Replace provider-specific permission vocabulary with three consistent Brigadier-level policies:

- **Ask for approval:** the owner decides requests requiring approval.
- **Approve for me:** Brigadier evaluates requests, handles those already covered by the owner's instructions, and uses independent judgments for uncertain or consequential requests where useful. Escalate requests requiring new authorization or unresolved evidence to the owner.
- **Full access:** actions proceed without permission prompts.

Explicit owner restrictions remain binding. Fusion never overrides those restrictions. Enforce the selected policy consistently in actual provider/harness behavior; relabeling incompatible native modes is insufficient. Do not mistake the permission mode for Auto/Custom execution configuration.

Use assistant-ui approval cards inline with the requested action. A small Approval needed strip above the composer jumps to the card without losing the draft. Show supported, meaningful choices. After confirmed resolution, fold the card into a compact status row. Preserve non-optimistic approval semantics, expiration and failed-response recovery; approval acceptance and successful execution are distinct states.

Fusion remains evidence-based judgment, not majority vote or a mandatory approval gate for every plan. Routine authorized orchestration can proceed. Independent work should remain able to progress while an unrelated work order awaits a decision.

## Context and visual layout

- No always-visible context-usage ring, session-full warning or routine compaction/handoff UI.
- Context card contains actual task environment/changes, locked setup details, sources and workers. Retaining its name does not imply a token meter.
- Surface concrete execution failures, observed allowance waits and required owner decisions when relevant. Do not present a provider window as remaining lifetime of the durable task.
- Match tmp-images references closely in dark-gray surfaces, rounded geometry, spacing, restrained borders, popovers and white circular Send/Stop button. Keep Brigadier typography, icons and accents; provide equivalent light-mode styling.
- Respond to actual composer container width as side panels open/close or resize. Shorten long labels first, then wrap controls into two deliberate rows. Keep permissions and Send/Stop visible. Fit popovers within available space, with usable scrolling where necessary.
- New-session Custom setup rail, attachments, queue rows and suggestion menus must also tolerate narrow layouts. Preserve focused input, draft and open-control usability during resizing.

## Implementation and verification boundary

Assistant-ui elements/primitives provide the UI; Brigadier remains responsible for durable state, execution, policies, routing and approvals. Follow current installed APIs and the already-approved rich editor approach rather than assuming catalog examples implement backend behavior.

Re-audit the current checkout before editing: related work has been merged during this interview. Preserve unrelated research and reference images. Verify the full interaction across new/existing tasks, per-project persistence, Auto/Custom transitions, provider changes, queued-setting snapshots, attachment errors, real references/commands, approvals and Stop/Continue. Exercise narrow containers with both side panels and popovers. Check provider-specific execution limits honestly and reconcile necessary backend gaps before calling a control complete. Run repository-required checks appropriate to the actual changes.

The grill-me interview is complete and the owner approved this consolidated understanding. Proceed with implementation without repeating the interview or asking for the same approval again. No product implementation occurred in the source interview task; only this spec and its architecture research note were added.

## Approved rail and picker amendment

The owner confirmed these changes in this task after reviewing additional references:

- The inset setup rail above the composer is available in both Auto and Custom before first Send. Auto honors explicit project/environment/branch selections and continues to choose only execution provider/model/effort. Workers remain independently configurable within task policy. The rail disappears after Send and locked setup stays in Context.
- Work locally, New worktree and Existing worktree are supported. All Git worktrees belonging to the project may be listed, including external ones, with path, branch and active task. Busy checkouts cannot be selected. Borrowed worktrees are not owned disposable resources and cannot be automatically removed by task cleanup.
- Current branch, New branch and Checkout are staged choices. New branch has a name and starting point; Checkout searches existing branches. Git mutations happen only on Send. Current input includes local changes; alternate starting branches use committed state. Never silently stash/discard changes. Project defaults persist across both modes.
- Auto/Custom is a standalone picker styled like Permissions in the existing lower-right location. Custom adds a neighboring provider/model/effort picker; Auto hides it. Before Send either direction is allowed; after start only Auto-to-Custom is allowed.
- Provider selection adapts assistant-ui SettingsPanel's segmented control. The effort slider follows the supplied thick rounded track, blue fill, large white thumb, step dots, current effort/model text and reset icon. Its steps map only to model-supported levels; reset returns to provider/model default, and unsupported effort has no interactive slider.

This amendment supersedes the earlier Custom-only setup-rail and combined mode/provider control descriptions above.
