# Claude native rewind and current context — 2026-09-05

## Sources and scope

- **[measured]** `/Users/stephen/.local/bin/claude --version` reports **2.1.261**; symlink resolves to `/Users/stephen/.local/share/claude/versions/2.1.261`.
- **[source]** Matching SDK **0.3.261** was already unpacked at `/private/tmp/claude-501/-Users-stephen-Development-brigadier-ai/ebd69ddb-dfc7-428d-a9c2-81ea75fba80b/scratchpad/hist/x-0.3.261/`. No package installation or SDK dependency added.
- **[source]** The actual native binary includes readable JavaScript. Offsets below identify that exact binary, not a stable public contract. SDK declarations omit one supported native request: `rewind_conversation`.
- **[documented]** Primary docs fetched 2026-09-05: [file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing), [statusline](https://code.claude.com/docs/en/statusline), [CLI reference](https://code.claude.com/docs/en/cli-reference).
- No paid model call has been made for this investigation. Protocol probes initialize an empty stdio session and send control requests only.

## Native conversation rewind: no respawn required

**[source]** Installed binary offset approximately `178306937`, branch `r.request.subtype === "rewind_conversation"`, accepts:

```json
{"type":"control_request","request_id":"unique-id","request":{"subtype":"rewind_conversation","target_message_uuid":"provider-user-uuid","last_seen_user_message_uuid":"latest-observed-provider-user-uuid","interrupt_if_running":false}}
```

Success body inside `control_response.response.response`:

```json
{"rewound":true,"targetMessageUuid":"canonical-user-uuid","prefillText":"original prompt text","precedingAssistantUuid":"previous-assistant-uuid-or-null"}
```

Failure body has `rewound:false`, `prefillText:null`, `precedingAssistantUuid:null`, and `error`. Known errors include `target not found`, `stale target`, `unseen later turn`, `turn running`, `prompt pending`, `commands queued`, `poll tool_result target`, `delivered poll events in range`, `failed to persist rewind anchor`, and `state changed`.

**[source]** The target is the user message being edited, not the previous assistant. Successful rewind removes that user and everything after it (`ct.splice(targetIndex)`). It persists the prior chain anchor, checks no racing turn changed the state, then truncates live context and invalidates affected cached read state. A first-user target is handled by the same native path. Rewind is not exposed in SDK 0.3.261's request union, so feature-detect the actual control response rather than assume availability by SDK version.

**[source]** `last_seen_user_message_uuid` is a concurrency guard. Without it, a later human user message makes an older target stale. With it, later user events beyond what the caller observed are rejected. Always pass the latest observed main-session user UUID. Do not substitute Brigadier's local `:user` row IDs.

**[source]** Specifically use the latest observed **human prompt** UUID. Native helper `$3` (binary offset `166240371`) excludes tool-result carriers, metadata, compact summaries, transcript-only display entries, non-human origins and stacked expansions. Helper `DEe` additionally detects queued human commands. A synthetic notification UUID should not replace the last human prompt guard.

**[measured]** `python3 work/probe-native-rewind.py` passed on CLI 2.1.261. It sent two `shouldQuery:false` user frames with generated UUIDs; both replay acknowledgements echoed their supplied UUID exactly. Their results had `num_turns:0`, `duration_api_ms:0`, zero usage, and no cost. Results:

| Request | Observed result |
| --- | --- |
| Unknown target in empty session | `rewound:false`, `target not found` |
| First user, omitting latest-user guard after second user | `rewound:false`, `stale target` |
| First user, latest-user guard = second user | `rewound:true`; first message text in `prefillText`; `precedingAssistantUuid:null` |
| Second user after successful rewind | `rewound:false`, `target not found` |

The successful case covers editing the first message and removing a multi-user tail without respawning. Fixture: `work/native-rewind-probe.json`. This proves conversation control, not file restoration or rewind after an actual tool run.

**[measured]** Restart persistence also passed: a new CLI process with `--resume=0e575bda-15d9-443c-9e42-de3b6a65542b`, initialized without a user/model frame, returned `target not found` when asked to rewind the removed first UUID. The original rewind survived process exit/resume.

**[asserted integration]** Restrict edit submission to an idle session, send native rewind, and update local visible conversation only after `rewound:true`. Preserve the old history on failure. Then submit the edited message with a fresh UUID. Send an explicit UUID on each outbound native user frame and store the provider replay acknowledgement (`--replay-user-messages`) to bind UI rows to native checkpoint IDs.

## File checkpoint rewind

**[source]** SDK `sdk.mjs` sets `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` for `enableFileCheckpointing`. `rewindFiles()` maps to:

```json
{"type":"control_request","request_id":"unique-id","request":{"subtype":"rewind_files","user_message_id":"provider-user-uuid","dry_run":true}}
```

**[source]** SDK `sdk.d.ts:3059` declares result `{canRewind:boolean,error?:string,filesChanged?:string[],insertions?:number,deletions?:number,skippedLinks?:number}`. `skippedLinks` is meaningful only after a real rewind; dry-run cannot predict all link-safety skips. Non-link restoration failures are not all represented by that count.

**[measured]** Installed CLI accepts this request after initialize. A random UUID with `dry_run:true` returns control success with `{canRewind:false,error:"No file checkpoint found for this message."}`. Successful file restoration is not yet measured here.

**[documented]** Only edits through Claude's Write/Edit/NotebookEdit checkpoint path are covered; shell writes and ordinary subagent edits are not. A foreground `context:fork` skill is the documented subagent exception. Directory changes are not restored. Native file rewind does not rewind conversation. Checkpoints must have been enabled when edits happened. Do not imply all repository changes can be restored. See linked checkpoint docs.

**[source]** No combined atomic conversation-plus-files control exists in the inspected dispatch. Native file restoration (`iZr`, binary offset approximately `162599400`) iterates tracked paths; it has link/path safety checks but does **not** distinguish later human/external edits to a tracked file from agent edits. It restores that file to the checkpoint, potentially replacing later external edits. This is whole-file restoration, not a reverse patch of agent-only changes.

**[source]** Dry-run reports changed paths and line counts; it does not authorize or mutate. Real rewind returns `canRewind:true` with possible `skippedLinks`; it can also partially restore some files while other backups fail. The native dispatcher turns a non-dry-run `canRewind:false` into a control error. Handle both control-level failure and a successful control response with false/partial result.

**[source]** Rewind does not consume a checkpoint. `Lf` (binary offset `178369658`) invokes `vVe` (`162597500`), which selects the latest matching snapshot and calls `iZr`; neither removes snapshots or backup records. A later dry-run on that same checkpoint is supported. However, **empty `filesChanged` does not prove full restoration**: `QDe` includes only nonzero text-line differences, plus existing paths whose target backup is null (deletion). It catches/omits backup/read errors, omits mode-only changes, and can omit restoring an absent previously-empty file because both missing and empty become an empty string in the text diff. Actual `iZr` uses existence/mode/size/content comparisons (`jtn`/`aZr`) as well. The mutation set can therefore exceed the preview; a preview-only backup manifest is incomplete.

**[source]** Actual restoration enumerates `fileHistory.trackedFiles`, not merely the target snapshot's keys. Each path resolves to the target snapshot's backup or the first version-1 backup found across snapshots (`ztn`, `162607515`); this covers files first tracked after the requested checkpoint. The recorded shapes are:

```json
{"type":"file-history-snapshot","messageId":"prompt-uuid","snapshot":{"messageId":"prompt-uuid","trackedFileBackups":{"relative-or-absolute-path":{"backupFileName":"0123456789abcdef@v1","version":1,"backupTime":"ISO-time","realParentDir":"absolute-parent"}},"timestamp":"ISO-time","preCheckpoint":true},"isSnapshotUpdate":false}
```

```json
{"type":"file-history-delta","messageId":"current-prompt-uuid","snapshotMessageId":"snapshot-being-updated","trackingPath":"relative-or-absolute-path","backup":{"backupFileName":null,"version":1,"backupTime":"ISO-time","realParentDir":"absolute-parent"},"timestamp":"ISO-time"}
```

`preCheckpoint` and `realParentDir` are optional; `backupFileName` is a validated backup filename string **or JSON null**. Native reload helper `kVe` unions keys from all loaded/reconstructed snapshots to recover `trackedFiles`; later deltas must be applied to their snapshot. Relative paths resolve against the native project working directory (`CCe`). Sources: `wV` (`162592600` vicinity), `insertFileHistorySnapshot` (`166421200`), `O7n` (`166438807`), `kVe` (`162607800`).

**[source]** Persisted records are not an authoritative live-set API: `wV` changes live state, then invokes snapshot/delta persistence asynchronously and catches/logs failures. Compaction/retention also changes the loaded set. No control request exposing the complete live `trackedFiles` set was found. **[asserted integration]** Do not enable a transaction-like combined rewind based only on a dry-run path list or unverified persisted-record union; it can miss files the provider will mutate. A complete capture mechanism needs its own validation.

**[asserted integration]** Serialize a combined edit with other session actions: idle/queue check, dry-run, reversible capture of affected current files if transaction-like recovery is required, actual file rewind, conversation rewind, local UI cut, edited prompt submission. No ordering alone makes the two provider operations atomic. If files changed but conversation rewind fails, preserve the displayed conversation and report that exact partial result (or restore captured files safely); do not automatically repeat the mutation. If conversation is rewound first and files then fail, the application must still record the already-completed conversation rewind. Never claim all changes restored from `canRewind:true` alone.

## Current context usage

**[source]** SDK `sdk.d.ts:3627` and `sdk.mjs.getContextUsage()` expose:

```json
{"type":"control_request","request_id":"unique-id","request":{"subtype":"get_context_usage","detail":"summary"}}
```

**[source]** `detail:"summary"` uses latest API usage plus local estimates; default `"full"` invokes per-category token-count APIs. Use summary for a cheap meter. Reply uses camelCase: `totalTokens`, `rawMaxTokens`, `maxTokens`, `percentage`, `model`, `categories`, with additive fields.

**[measured]** Empty initialized CLI 2.1.261 returned `totalTokens:25315`, `rawMaxTokens:1000000`, `maxTokens:1000000`, `percentage:3`, `model:"claude-opus-5[1m]"`, `apiUsage:null`, `autoCompactThreshold:967000`, `autocompactSource:"model-default"`. No user/model turn was needed. Thus zero chat messages is not zero context: tools, system prompt, memory and skills already count. Probe record: `work/rewind-context-control-probe.json`.

**[source]** SDK's structured `/context` type (`sdk.d.ts:3468`) defines usage as estimated, permits values over the limit, and defines `raw_max_tokens` as the resolved autocompact window, which can be lower than the model's maximum. Label the meter as a provider context estimate; do not label it exact or confuse it with subscription use.

**[source]** `result.usage` and `result.modelUsage` are cumulative accounting and must not drive current context occupancy. Latest main-loop assistant usage is a fallback snapshot, never a session sum. Filter subagent frames (`parent_tool_use_id` non-null). A context summary query after compaction/rewind/model switch avoids stale historical totals.

## Resume fallback

**[source]** SDK `sdk.d.ts:1931-1990` supports `--resume=<session> --fork-session --resume-session-at=<last-kept-chain-UUID>`. This truncates inclusively at the kept entry. `--resume-drops-turn=<discarded-prompt-UUID>` rejects discarded ranges containing other turns; it is unsuitable for blindly deleting an arbitrary multi-turn tail. These flags apply to the stdio/headless lane only. Last kept chain entry may be a tool result or structured-output attachment, not an assistant.

**[asserted integration]** Prefer the measured native `rewind_conversation` path. If unavailable, expose unsupported unless the application has a fully validated native resume/fork implementation. Never emulate rewind by sending a natural-language instruction to forget history.

## Workhorse panel signals

**[source]** SDK 0.3.261 `sdk.d.ts:5210-5315`: `system/task_started` carries `task_id`, optional `tool_use_id`, `description`, optional `subagent_type`, `task_type`, `is_backgrounded`; `task_progress` carries description, optional summary and last_tool_name; `task_updated.patch` can update status/description; `task_notification.status` ends with completed/failed/stopped. These events do not advertise a per-task model field. Main/subagent assistant messages carry `message.model` and `parent_tool_use_id`, which can join model observations to an originating task tool call. Leave model unknown until observed rather than infer from the lead's selection.

**[source]** `background_tasks_changed` (`sdk.d.ts:3398`) is a full replacement snapshot of live background task IDs/types/descriptions. It is per process; clear on process restart. Ambient tasks must not imply active agent work. Foreground tasks are not all represented by this background-only set.

## Reconciling an unconfirmed conversation rewind

**[source]** The inspected native control dispatch has no live `get_messages`/conversation-history read request. SDK `getSessionMessages()` is an out-of-band historical JSONL reader; its documented public API is not a live process view.

**[measured]** Calling matching SDK 0.3.261 `getSessionMessages()` on the successfully rewound probe session **still returned both removed user bodies** after process exit. Native resume correctly excluded them (probe above). **[source]** SDK `cHe`/`lHe` retains message-like records and selects the latest parentUuid leaf; it ignores `last-prompt` explicit rewind anchors. Therefore raw JSONL message presence or this SDK getter must not resolve an ambiguous mutation as "not rewound".

**[source]** Native `VEe` (`166429237`) records the rewind as `{type:"last-prompt",leafUuid:<kept-anchor-or-null>,explicit:true,rewound:true,sessionId:<id>}`. The measured first-message rewind has `leafUuid:null`. Later non-explicit last-prompt metadata may omit leafUuid. A reliable recovery reader would have to implement native explicit-anchor precedence and chain reconstruction, handle persistence races/failures, and be checked against CLI resume; that recovery implementation was not built here.

**[source]** In the native conversation handler, the direct outer control-error branch rejects a non-string target UUID before mutation. Unsupported-control errors likewise precede the handler. Normal refusals use outer success with `rewound:false`. These specific errors can be treated as no conversation truncation; arbitrary timeout/EOF/parser/unknown errors cannot. Even `rewound:false` persistence/state-changed results may follow task stopping or an attempted anchor write/heal, although the live conversation splice has not run. Do not treat them as proof that absolutely no side effects occurred.

## Unchecked

Successful restoration of checkpointed Write/Edit/NotebookEdit modifications, concurrent-writer races, interrupted-turn rewind, and Codex equivalents were not exercised. No Codex integration recommendation is made from this Claude-only investigation. Installed version support is measured; an earliest-version bound for the undocumented conversation request is not established.
