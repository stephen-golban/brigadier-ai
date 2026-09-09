# ChatGPT subagents and Brigadier: research and design brief

Research date: 9 September 2026. Status: shared design approved by Stephen after the interview; implementation is authorized in a new task. Recorded interview decisions govern the recommendations below and supersede conflicting historical requirements. Scope: the supplied Codex desktop references, documented ChatGPT Work/Codex behavior, and Brigadier's current source. No product implementation changed during this research.

## Principal finding

Brigadier has the foundations for a single conversation coordinating internal workers across providers. It does **not** yet establish that it selects the best provider, model, and effort for each assignment. It exposes selection controls and instructions, with several defaults that still favor one provider or the run's existing provider. Its stronger automatic review and repair machinery belongs to a separate workflow from ordinary conversational delegation.

The right target is a coherent user experience backed by one consistent execution policy: the selected main model remains responsible for the conversation; workers receive bounded assignments; their activity is inspectable; results return with evidence; and model choice is justified against actual capabilities and measured outcomes. These are proposed refinements, not a claim about ChatGPT's private implementation.

## 1. What the external evidence establishes

### ChatGPT Work, local Codex, and the API are different surfaces

OpenAI documents specialized parallel workers, separate working contexts, and summarized returns to the main conversation. Local Codex allows per-agent model/effort configuration and inherits the parent configuration when appropriate. ChatGPT Work's delegation behavior varies with intelligence level. The web Subagents view provides read-only Active/Done lists; desktop documentation describes opening worker activity from the main conversation and asking the main agent to steer or stop workers. Local workers inherit permission settings. These statements describe documented product behavior, not every account or historical release. [OpenAI: Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)

The hosted Responses Multi-agent beta documents a root and descendant tree with spawn, passive messaging, follow-up work, waiting, interruption, and listing. Its concurrency cap spans descendants and excludes the root. In that API, agents share the request's model and tools. Output events identify their agent; root and worker context compaction is independent. This is useful architectural evidence, but it does not prove that the desktop UI uses that exact backend or provide a cross-provider router. [OpenAI: Multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent)

OpenAI's Agents SDK distinguishes handing conversation ownership to a specialist from calling specialists as tools while a manager retains the reply. The latter matches Stephen's requirement that users talk to the orchestrator. The SDK is a documented construction pattern, not evidence that every ChatGPT product is built with that SDK. [OpenAI: Orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration)

### What the supplied screenshots establish

The repository contains screenshots of the Codex desktop surface. They are direct visual evidence of the captured state; their exact app version and account configuration are not recorded here. They show:

| Reference | Visible behavior | What it cannot establish |
|---|---|---|
| [Context card](../plans/brigadier-20260909/references/context-card.png) | Environment, real change counts, local workspace, branch, Git actions, Subagents summary, Sources | The conditions under which an empty Subagents section disappears |
| [Workers list](../plans/brigadier-20260909/references/workers-list.png) | Main chat stays visible beside a Subagents tab; Active and Done groups; worker names and recency | Cancellation, restart, or persistence semantics |
| [Worker result](../plans/brigadier-20260909/references/worker-thread.png) | Back navigation, worker title, elapsed work summary, final answer, artifact link | Whether the result has been accepted or integrated by its parent |
| [Expanded activity](../plans/brigadier-20260909/references/worker-expanded-activity.png) | Expandable grouped work and intermediate activity above the result | Access to private model reasoning or complete backend context |

There is no worker composer visible in those worker-detail screenshots. The main composer remains in the parent conversation. This supports an activity-inspection design; a screenshot alone is not proof that no other interface offers worker interaction.

Stephen's explicit requirement settles the Brigadier choice: no worker conversation composer, no permanent Subagents toolbar action, and access through context or conversation activity after workers exist. That requirement is stronger evidence for our product than attempting to extrapolate every possible behavior from a reference image.

The context card is a **navigation and task-information surface**. It should not be presented as a literal inventory of everything currently in a model's context. Sources shown to a user, accessible project files, retrieved excerpts, and tokens actually supplied to a worker are different things.

### What remains unknown

Public documentation and these screenshots do not establish ChatGPT's private task-difficulty classifier, model scoring formula, review triggers, cross-provider selection policy, internal summaries, or exact storage/recovery implementation. They do not show that ChatGPT routinely fuses Claude and OpenAI models. They also do not establish that a higher agent count improves any particular Brigadier task.

Accordingly, “works similarly” should mean a comparable interaction and execution contract. It should not mean claiming an identical private orchestration algorithm.

## 2. Current Brigadier audit

These findings concern the current source snapshot, including the prior uncommitted implementation. They are code inspection findings, not new live provider acceptance tests.

| Area | Current implementation | Gap or practical limit |
|---|---|---|
| Conversation ownership | Internal workers use `subagents`; separate chat provenance uses `origins`; root-only user interaction | Historical documents describing directly messaging workers are superseded |
| Navigation | Worker chats excluded from ordinary conversation navigation; context and linked activity open the panel | UI parity still needs task-state semantics beyond process state |
| Delegation | `delegate_task` creates a worker and assignment; separate `create_session` creates a chat | The delegation input does not require a structured routing justification |
| Provider choice | Explicit connected provider accepted, exclusions and observed allowance checked | Omitted provider defaults to `claude-code` |
| Model catalog | Registered adapters expose observed models; Codex refreshes its catalog | Availability metadata is not competence evidence; unknown catalogs remain possible |
| Effort | Worker effort is accepted separately from root effort | Delegation schema has a fixed enum; it cannot represent every future/provider-supported value |
| Root selection | Explicit root model is preserved; worker choices are independent | Independent choice support does not establish good choices |
| Context | Assignment, forwarded attachments, role context, bounded durable checkpoint | No general provider-neutral conversation-fork or relevance-scored context compiler demonstrated |
| Results | Durable completion receipts, cursors, suppression when parent already observed results | No demonstrated general outcome-ranking or routing-learning system |
| Stop | Durable task stop and descendant ownership handling exist | Must remain authoritative over late completion and allowance resets |
| Review | Conversation prompt requests risk-based independent review | Prompt compliance is not a compulsory review gate |
| Automatic workflow | Two review perspectives and an evidence judge; bounded repair alternatives | App `start_run` fixes the run provider to Claude; reviews and alternatives are serial and use run/default provider choices |

### Evidence pointers

- [Peer runtime](../../src-tauri/src/peers.rs): `instructions`, `rpc`, creation branch; provider fallback around line 701, ownership-wide live limit around line 750, project exclusions and permission inheritance thereafter.
- [MCP tools](../../src-tauri/src/peer_mcp.rs): `list_providers`, `create_session`, derived `delegate_task`; effort enum currently `auto`, `low`, `medium`, `high`, `xhigh`, `max`.
- [Provider catalog](../../src-tauri/src/provider_catalog.rs): model/effort/usage metadata; Claude effort options partly constructed by the app, Codex efforts taken from observed model rows.
- [Task memory](../../src-tauri/src/task_memory.rs): revision checks, durable decisions/results/verification, compact injected summary bounded to 16 KiB; full checkpoint remains retrievable.
- [Completion delivery](../../src-tauri/src/peer_completion.rs): worker-turn receipt identity, parent wake, stop checks, observed-result suppression.
- [Worker tree](../../src/workerTree.ts): ownership traversal and UI grouping.
- [Context card](../../src/components/SessionCard.tsx) and [Subagents panel](../../src/components/SubagentsPanel.tsx): conditional section, Active/Done lists, worker detail, root interaction notice and Stop.
- [Workflow lead](../../crates/supervisor/src/loop_/plan.rs): advertises registered provider names and asks for independent worker choices; it does not supply a measured capability-ranking dataset.
- [Work orders](../../crates/supervisor/src/action.rs): optional provider/model/effort alongside required legacy `model_tier`.
- [Routing](../../crates/supervisor/src/loop_/routing.rs): Claude tier aliases; another provider receives its default if no explicit model is selected.
- [Application run entry](../../src-tauri/src/commands.rs): `start_run` checks Claude availability and constructs `RunSpec` with `DriverKind::new(CLAUDE_CODE)`; it has no provider argument.
- [Review](../../crates/supervisor/src/loop_/review.rs), [repair alternatives](../../crates/supervisor/src/loop_/ladder.rs), and [integration gates](../../crates/supervisor/src/loop_/green.rs): enforcement in the automatic workflow.

### The two orchestration paths must not be conflated

The conversational path is an ongoing model session with Brigadier tools. The model chooses whether to delegate, review, integrate, and update its checkpoint. The harness enforces specific boundaries such as permissions, limits, delivery bookkeeping, and stopped state.

The automatic plan workflow makes disposable planning/lead calls, dispatches structured orders, and runs verification gates. Its review trigger checks whether at least five paths changed or path names contain terms such as permission, migration, payment, or session. Two reviewers run in separate calls, followed by a judge. A supported material finding blocks acceptance. These are real checks, but filename matching is an incomplete proxy for risk.

After an ordinary repair fails, the automatic workflow creates two isolated alternatives from the pre-repair snapshot. Each faces the required command and review. A judge can select an eligible complete branch or reject both; the selected result is checked again. It does not blindly concatenate competing changes. However, both alternative calls have `provider: None`, `model: None`, and `effort: None`, and run serially. The reviewers also omit those selections. Independence of prompts exists; deliberate provider/model diversity does not.

The application exposes this automatic workflow separately through its plan commands. Its `start_run` entry explicitly requires Claude and fixes the run provider to `CLAUDE_CODE`; it does not accept a provider selection. Consequently its default reviewers and repair alternatives use Claude through that entry, even though explicit work orders can select another registered provider. Its presence does not guarantee that every task submitted through the ordinary composer traverses those gates. A shared orchestration policy must cover both execution paths or the product will make promises one path cannot keep.

### “Done” currently needs a more precise meaning

`workerTree` classifies closed or exited sessions as Done. An idle running session with an ended turn can be marked Awaiting integration. This is already more informative than treating all idle workers as successful, but process exit and task success remain different facts. The product should separately record execution state and contribution disposition: a stopped process may have useful unintegrated work; a completed result may be rejected; a failed process may still have a saved partial artifact.

## 3. Proposed common execution model

The following recommendations are pending the interview.

### One task, one accountable orchestrator

Keep the exact main provider/model selected by the user. Permit the orchestrator to choose other eligible providers/models for bounded worker assignments. A worker belongs to the task, even if its provider changes or its process is replaced. Separate user conversations retain independent lifecycle.

Every assignment should carry an objective, scope, input snapshot, acceptance criteria, expected output, write ownership if applicable, tool/permission requirements, and the selected execution configuration. A worker may report a question to the orchestrator. The orchestrator answers from existing decisions where possible and asks the user only for a consequential missing decision.

The runtime should distinguish creating an assignment from starting its process and delivering its prompt. A retry with the same request identity must reconcile the existing assignment instead of producing another worker. The UI should expose a short task name immediately, then accurate Starting, Working, Waiting, or failure state.

### Delegate when it improves the outcome

Use direct execution for a small well-defined edit. Delegate a bounded search, independent component, alternative hypothesis, or specialized review when its result can be useful without duplicating the entire task. Define dependencies before concurrent writes. Workers should not all start on the same files merely because spare model capacity exists.

Anthropic's research-system report supports bounded objectives, explicit output contracts, contextual separation, and effort scaled to the task. It also reports substantial orchestration overhead and cautions about tightly coupled coding work. Its published research benchmarks are not a transferable prediction for Brigadier's coding performance. [Anthropic: Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

For Brigadier, a proposed dispatch decision should state its practical benefit: for example, “check the migration independently while the UI work proceeds.” It should not need a long explanation to the user on every spawn. A brief reason can live in worker details and the execution record.

### Context should be scoped, attributable, and durable

Prepare a compact assignment brief from accepted requirements and relevant files. Include the exact workspace baseline and changes the worker is expected to see. A branch name by itself does not identify an unfinished working tree. Reuse artifacts by stable handles; disclose which sources were included rather than implying that every source in the context card was supplied verbatim.

Cross-provider continuation should use an explicit handoff artifact: assignment, accepted decisions, evidence, pending work, source pointers, and workspace state. It should not promise transfer of another provider's hidden reasoning or opaque session state. Full conversation duplication can be an intentional option for tightly coupled work, but it should not be the default way to manufacture independence.

Workers return a compact result with evidence and artifact links. The root can retrieve relevant detail on demand. Durable state should retain current decisions and unresolved criteria across context compaction. User decisions need a protected, durable representation so they do not depend on remaining in a recent-message window.

### Completion should trigger useful continuation

Represent result submission separately from parent acceptance and integration. A completed worker should return its outcome, checks, remaining uncertainty, and workspace/artifact references. The root then decides whether to accept, request repair, discard the contribution, or integrate it.

Batch results that arrive together when doing so avoids redundant root calls, while waking promptly for a blocker or a result needed to continue. Passive information must not create acknowledgement loops. Once the root has consumed a result through a wait/read, it should not receive another work turn solely announcing that same result.

Stop remains a durable user decision. Late results can be retained without restarting execution. Recovery should reconcile actual processes, pending tool effects, and delivery receipts before resending work. Retiring a worker may release its process and disposable workspace only after evidence and unintegrated work are safely retained according to the task's storage policy.

## 4. Provider, model, and effort selection

### Define what “best” means

There is no task-independent best choice. A useful policy first establishes required quality, then compares time and usage among eligible configurations. OpenAI explicitly recommends evaluating against an accuracy target before optimizing cost and latency, with hard constraints applied first when necessary. [OpenAI: Model selection](https://developers.openai.com/api/docs/guides/model-selection)

The unit to evaluate is the **model plus provider adapter, tools, effort, and task context**. A capable model without the required tools may be the wrong execution choice. A provider's marketing benchmark cannot establish reliability with Brigadier's local CLI integration.

Proposed selection sequence:

1. Honor explicit user model assignments and provider exclusions.
2. Remove configurations lacking required tools, modalities, context capacity, or permission support.
3. Resolve actual available model IDs and supported effort values from the connected adapter, with freshness recorded.
4. Consider observed allowance, expected duration, and remaining task budget; unavailable usage is not zero usage.
5. Rank eligible configurations using task-specific evidence and an uncertainty estimate.
6. Choose a configuration and record a concise reason, alternatives considered, and whether the decision rests on measurements or a provisional prior.
7. Check the actual resolved model after startup when the provider exposes it; preserve requested and observed configuration separately.

The policy should not enforce “Claude for design, Codex for code” as immutable categories. Suggested workload classes include code exploration, mechanical edits, ambiguous implementation, debugging, architecture, UI evaluation, research, and adversarial review. Their routing evidence can change with model and adapter versions.

### Evidence before claims of intelligence

Begin with provisional capability profiles based on official documentation and local availability. Label them as priors. Evaluate representative Brigadier tasks with fixed acceptance criteria, repeated trials, and matched constraints. Compare routing against simple baselines: the selected root model for everything, the provider default, and a basic lightweight/strong-model heuristic.

Record actual task acceptance, regressions, review findings confirmed by evidence, repair attempts, latency, usage, and integration success. Completion text alone is not a success label. A low-confidence history of a few tasks should not become a permanent model ranking. Update or expire evidence when the model, CLI adapter, tools, or workload changes.

Use held-out tasks to test policy changes. Avoid rewarding a reviewer for producing many findings or a builder for weakening a test. Manual acceptance remains valuable for UI and product requirements that executable checks cannot fully judge. An initial evidence set can be modest, but it must not be advertised as proof of universal superiority.

### Effort needs provider-specific translation

Treat effort as a supported property of the chosen model and adapter. Identical labels across providers do not establish equivalent compute or quality. Claude's effort documentation explicitly describes a token/thoroughness tradeoff with model-dependent support. Its API documentation does not automatically define the controls a particular installed CLI exposes. [Anthropic: Effort](https://platform.claude.com/docs/en/build-with-claude/effort)

Brigadier's fixed delegation enum is therefore a concrete compatibility gap. The future policy should validate the final tuple rather than invent unsupported settings. It should also distinguish increasing effort from changing model, adding context, improving the task definition, and adding an independent reviewer; these solve different problems.

Native provider subagents are a separate execution mechanism. Claude Code documents its own model inheritance, overrides, and possible substitution rules. That reinforces the need to inspect actual execution settings, not just the requested alias. Brigadier should own cross-provider assignment identity even when an adapter uses native provider functionality internally. [Claude Code: Custom subagents](https://code.claude.com/docs/en/sub-agents)

## 5. Fusion, adversarial review, and competing solutions

These should be three explicit operations with different outputs.

**Fusion of findings:** independent investigators return claims, evidence, uncertainties, and coverage. The orchestrator reconciles them against the sources and task criteria. Agreement can guide attention but does not establish correctness. Conflicting evidence should survive into the decision record until resolved.

**Adversarial review:** a reviewer challenges a concrete candidate against requirements and likely failure modes. To preserve independence, initially provide the specification, baseline, candidate changes, and checks without the builder's persuasive explanation. Afterwards, permit questions and rebuttal. A different provider/model can add a useful perspective, but diversity is a hypothesis to evaluate, not a guarantee against shared errors.

**Competing implementations:** two workers independently attempt alternative repairs or designs from the same baseline. They should not see each other's proposal before submitting their own. Compare complete candidates against the same criteria. Select one, or deliberately create a new integration candidate and test it as new work. Combining fragments does not inherit either candidate's verification.

Anthropic's architecture guidance distinguishes task sectioning, parallel judgments, dynamic orchestrator/worker decomposition, and evaluator/optimizer loops. These are useful patterns, but the presence of a pattern alone does not prove an implementation correct. [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

Recommended review intensity should follow impact and uncertainty. An isolated typo usually needs no adversarial panel. A permission change, migration, cancellation race, or ambiguous multi-component feature often merits independent review. Retry limits and a remaining-budget check should prevent endless disagreement loops. A consequential unresolved disagreement belongs with the orchestrator and, when it is a product decision, the user.

## 6. Proposed user experience

| Surface | Proposed contract |
|---|---|
| Main conversation | Requirements, brief progress, user decisions, approvals, synthesized result |
| Context card | Environment, changes, sources; Subagents appears after delegation exists |
| Subagents summary | Counts reflecting meaningful task state, with a link into the panel |
| Conversation activity | Compact delegation/result entries that open the corresponding worker |
| Panel list | Active and Done for scanability; explicit substatus for waiting, stopped, failed, awaiting integration, accepted, or rejected |
| Worker detail | Assignment, provider/model/effort, selection reason, grouped activity, result, checks, artifacts, parent link |
| User interaction | Instructions and questions go through the main conversation; Stop can remain a direct control |
| Completed history | Results stay inspectable after processes and disposable resources retire |

The panel should reuse the existing right-hand workspace area and preserve its selection during navigation. Opening a worker should keep the parent visible and not change which conversation the main composer targets. A stale link should show retained history or an honest unavailable state, never silently navigate to an unrelated chat.

The Sources section should show actual references and attachments with usable actions. It should distinguish task inputs from generated outputs where useful. Worker-specific sources belong in worker details; the top-level card should remain concise. Missing or unsupported controls should not be represented as decorative buttons.

## 7. Acceptance scenarios for the eventual implementation

These are proposed behavioral checks, not tests run during this research.

1. A small clear edit completes directly without unnecessary workers or review.
2. A task with independent research and implementation creates justified workers and keeps one main conversation.
3. A Claude root can dispatch an eligible Codex worker and the reverse; requested and observed model/effort are visible.
4. Auto selection cannot silently fall back to Claude merely because the provider field was omitted.
5. An unsupported model/effort tuple is rejected or explicitly replanned before execution; no hidden downgrade is labeled as the requested configuration.
6. A reviewer sees an independent brief and detects a seeded consequential defect; unsupported findings do not block forever.
7. Two competing fixes begin from the same baseline; the winner passes full acceptance after integration.
8. Completed, accepted, integrated, stopped, and failed outcomes display accurately.
9. Context and conversation links open the same worker detail without changing the main composer target.
10. Parent Stop interrupts owned descendants, blocks new dispatch, and survives restart and late completion.
11. Worker permissions remain within the task's policy across provider selection and resume; approvals retain exact originating action and worker attribution.
12. Duplicate completion or creation events do not repeat assignments or root work turns.
13. Cross-provider reassignment preserves the work artifact and explicit task state while accurately reporting that provider-native conversation state was not transferred.
14. Routing is compared with simple baselines on held-out tasks; success means better outcomes under the chosen budget/latency policy, not merely more agents.

## 8. Interview map

Existing decisions to preserve: assistant-ui, exact main model selection, separate ordinary conversations, internal view-only worker activity, no Subagents toolbar button, durable Stop, provider exclusions, and no silent main-model substitution. The latest user direction supersedes old handoff text allowing direct worker messages.

Resolve the remaining branches in this order, one question at a time:

1. Default quality/time/usage objective and the point at which extra work becomes disproportionate.
2. Automatic delegation thresholds and the level of user-visible explanation.
3. Routing evidence, provisional defaults, explicit worker overrides, and provider-unavailability behavior.
4. Context selection and exact workspace snapshot semantics.
5. Review triggers, reviewer independence, fusion, competing attempts, and stopping criteria.
6. Active/Done semantics, retained results, and the lifecycle of an idle or stopped worker.
7. Nested delegation, shared limits, root continuation, and recovery edge cases.
8. Final acceptance scenarios and confirmation of the shared design before implementation.

### Recorded interview decisions

1. Stephen accepted quality first with proportionate usage: handle simple work directly, select economical capable workers for bounded assignments, and escalate models, effort, or independent review when uncertainty or consequences justify it. This policy must be configurable in app settings and project settings. Proposed settings inheritance: app-wide default with per-project overrides. The precise controls and spending boundaries remain open.

2. Stephen accepted Quality / Balanced / Economy presets with optional advanced controls for allowed providers/models, concurrency, usage limits, and review intensity. App-wide defaults can be overridden per project. Quality remains proportionate and avoids unnecessary agents for trivial work. Exact preset thresholds and enforceable usage units remain to be defined.

3. Stephen accepted adaptive model selection: begin with maintained capability profiles, then update selection evidence from projects' verified outcomes, confirmed defects, speed, and usage. The orchestrator proposes provider/model/effort; Brigadier validates the tuple against settings and available capabilities. A model's self-reported success is insufficient evidence, and sparse results must not permanently bind a task category to a provider. Precise evaluation, confidence, and evidence-aging rules remain open.

4. Stephen accepted automatic provider fallback for automatically selected workers when the preferred provider is unavailable or rate-limited, provided another allowed configuration meets the quality requirement. The switch is visible in worker activity and completed work is preserved. Explicitly pinned models wait and surface the blocker. Before retrying interrupted work elsewhere, Brigadier reconciles changes and uncertain effects already produced. This does not permit automatic substitution of the explicitly selected main model.

5. Stephen accepted preferring a reviewer from a different provider than the builder for consequential changes, when comparably capable and within configured constraints. Otherwise use a separate reviewer with fresh context on the same provider. Initially supply requirements, candidate changes, and checks without the builder's persuasive explanation, so the reviewer forms an independent judgment. Provider diversity is a preference, not a requirement to choose an unsuitable reviewer.

6. Stephen accepted selectively trying two competing approaches upfront when uncertainty is high and choosing wrongly would be expensive, within the project's usage limits. Otherwise use one implementation owner and escalate after a failed ordinary repair. Attempts remain isolated and face the same acceptance criteria; integrate only a verified result. Stephen additionally requires asking the user before launching competing implementations when the permission mode is not Full access. This approval requirement applies to competing implementations; routine independent read-only reviews and combining findings can proceed automatically within settings and existing tool permissions. Full access does not override configured usage limits or provider exclusions.

7. Stephen accepted focused worker briefs as the default, containing relevant user decisions, acceptance criteria, files, and workspace state, with access to further context when needed. Do not routinely copy the entire main conversation into every worker. The orchestrator remains responsible for carrying applicable user requirements into each assignment and preserving reviewer independence.

8. Stephen accepted automatically redirecting affected workers when a requirement changes in the main conversation: update assignments, stop incompatible work, and recheck completed contributions against the new requirement while unaffected workers continue. If a provider cannot accept instructions mid-run, pause or restart the affected worker with updated context. Show when the change actually takes effect rather than treating queued instructions as applied. Preserve completed work and reconcile uncertain effects before restarting.

9. Stephen accepted moving a worker to Done when its assignment finishes, with a separate contribution status such as Awaiting review, Integrated, or Rejected. Failed and stopped workers must be explicitly marked. Assignment completion does not imply that the orchestrator verified, accepted, or integrated the contribution; process termination alone must not imply success.

10. Stephen accepted pausing at a configured usage limit and asking before continuing, including in Full access: stop new dispatch, preserve work, and offer to increase the limit or continue with a cheaper plan. Warn in advance where usage is measurable. Unknown usage stays explicit; do not promise exact enforcement for unavailable or delayed provider measurements.

11. Stephen explicitly requires using the available assistant-ui Elements, with https://www.assistant-ui.com/llms.txt as the catalog. Prefer suitable existing Elements and primitives, adapted to Brigadier's real data and behavior, rather than recreating supported UI. This reinforces the existing assistant-ui choice; it does not require adding every unrelated element or changing the local provider backend.

Stephen confirmed the shared specification: "good, i approve. But please create a new session and hand it this whole work, because this already very long". Implementation is authorized in the new task; do not repeat the interview or request another general plan approval. Routine implementation details, including initial configurable thresholds and evidence-aging mechanics, should follow the accepted policy and be documented. Only consequential unresolved product decisions require further clarification. No implementation changes were made during this interview.

## 9. assistant-ui component mapping

The complete documentation index was inspected, including its Elements catalog, and relevant component/runtime documentation was opened. The repository currently pins `@assistant-ui/react` 0.15.18 and `@assistant-ui/react-lexical` 0.2.12. Its thread already uses `useExternalStoreRuntime`, and the rich editor uses assistant-ui Lexical directives. Current online examples still require compatibility checks against those installed versions before adoption.

| Agreed surface | Preferred assistant-ui building blocks | Brigadier integration responsibility |
|---|---|---|
| Main conversation and worker details | Thread/Message primitives; `ReadonlyThreadProvider` for worker activity; existing markdown and code elements | Stable identity, pagination, live feed, explicit worker read-only scope |
| Worker roster and grouped activity | Subagent list, Agent status, Tool group, Tool timeline | Actual per-worker state, hierarchy, arbitrary completion order, no fabricated progress |
| Model/provider/effort selection | Model selector with custom per-model effort options | Connected catalog, exact root selection, exclusions, requested versus observed configuration |
| Fusion and tool approvals | Approval card | Root attribution, exact request identity, backend-enforced gate, actual permitted response options |
| Follow-up queue | Message queue and queue primitives | Durable queue, acknowledgement before removal, Stop/resume and steering semantics |
| Comparing candidates | Comparison card and reviewable/code diff elements | Evidence and criteria, candidate snapshots, selection and integration checks |
| Context and sources | Sources, Attachment, File/Document reference; Popover and layout primitives | Environment card, truthful source provenance, conditional Subagents summary |
| Limits, interruption and recovery | Quota banner, Cost meter where measurable, Stopped run, Connection state | Observed usage, authoritative stopping state, recovery receipts |
| App/project policy | Settings element and Select/Switch/number-input composition | Presets, inheritance, advanced overrides and persistence |

This is a selection and integration map, not a claim that the library implements Brigadier's orchestration. The external-store pattern keeps Brigadier's durable backend authoritative. Worker detail can use the documented read-only provider without a user composer. [ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store), [Multi-Agent Chat UI](https://www.assistant-ui.com/docs/tools/multi-agent)

Three concrete adaptations are necessary:

- The documented SubagentList uses a prefix completion count, so its first N entries are marked complete. Brigadier workers can finish in any order and have richer outcomes. Adapt this installed/copied element to stable per-worker status; do not use its count to mark the wrong worker complete. Its percentage display also needs actual progress data or an indeterminate presentation. [Subagent list](https://www.assistant-ui.com/elements/subagent-list)
- ApprovalCard's documented standalone Done state currently displays a successful exit value without accepting an exit-code prop. Adapt the result rendering so a failed command or non-command fusion decision cannot appear as exit-zero success. Approval callbacks must await Brigadier's acknowledgement. [Approval card](https://www.assistant-ui.com/elements/approval-card)
- MessageQueue offers controlled display and runtime-backed variants. The standalone example's array operations do not provide durable delivery guarantees. Connect it to the existing acknowledged queue instead of creating a competing in-memory queue. [Message queue](https://www.assistant-ui.com/elements/message-queue)

The ModelSelector supports custom effort sets and a controlled variant. Feed it adapter-advertised choices and translate selections through Brigadier's Tauri bridge; the example HTTP backend wiring is not automatically applicable to this local app. [Model selector](https://www.assistant-ui.com/elements/model-selector)

Other mapped elements are candidates discovered in the catalog; verify each selected element's concrete props, source, accessibility, and version compatibility while implementing. Keep task information visible through context and conversation links, with no permanent Subagents toolbar action and no transfer of user conversation ownership.

## Source scope and limitations

Official pages above were accessed on 9 September 2026. OpenAI pages are living documentation and may describe different deployment surfaces or rollout stages. Anthropic's multi-agent engineering case study is dated 13 June 2025; its historical model measurements are not current provider rankings. The reference screenshots are local supplied artifacts, not a fresh live exploration of the Codex application.

The source audit establishes implementation structure and concrete defaults. It does not establish measured model-selection quality, a fresh mixed-provider end-to-end run, or private ChatGPT internals. Earlier build and unit-test results validate specific implementation behavior; they do not substitute for routing evaluations. No paid model benchmark, new live worker run, application replacement, or product-code edit was performed for this research.
