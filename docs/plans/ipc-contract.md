# IPC contract: webview ↔ Rust (phase 2)

Date: 2026-09-02. Status: contract for the phase-2 work orders. The Rust side (`src-tauri`) and the
TypeScript side (`src/`) are built by different workers against this file; neither may change a name
or a shape here without the lead re-issuing both orders.

Research this rests on: `docs/research/tauri-runtime.md` §3–§4 (Channel, 8192-byte cliff, ordering,
drop semantics), `docs/research/feed-rendering.md` (row cost, batch cap, rAF ingestion, FPS meter),
`docs/research/orphan-sweep.md` (pid files, sweep), `docs/research/persistence.md` §5–§6 (data dir,
`run_id`, expired approvals), `docs/research/tauri-commands.md` (command signatures; pending).

## Conventions

- Commands are `#[tauri::command]` functions with snake_case names and snake_case Rust argument
  names. The TypeScript side passes arguments in **camelCase** (Tauri's default mapping); the
  `bridge.ts` module is the only place that spells command names and argument keys.
- Every command returns `Result<T, AppError>`. `AppError` serializes as
  `{ "code": string, "message": string }`. Codes used: `claude_not_installed`, `claude_too_old`,
  `no_such_session`, `no_such_project`, `no_such_request`, `session_not_running`, `store`,
  `driver`, `io`, `invalid_argument`.
- Timestamps cross the wire as **milliseconds since the Unix epoch** (`number`), field suffix `_ms`.
- Ids are strings: `session_id`, `project_id`, `request_id`, `turn_id`, `instance_id`.
- Canonical events use the serde shapes from `crates/core/src/event.rs` verbatim: `Envelope` is a
  plain struct `{ seq, at, instance_id, session_id, event, raw? }` where `at` is already
  milliseconds (`#[serde(with = "millis")]`); `Event`, `ItemKind`, `RequestKind`, `Decision` are
  internally tagged with `"type"` in kebab-case (`"turn-completed"`, `"tool-permission"`,
  `"allow"`, `"deny"`); `ExitReason`/`AbortReason`/`StopReason` are bare strings for unit
  variants and `{ "error": "..." }` / `{ "other": "..." }` for tuple variants;
  `PermissionMode` is a bare string (`"default"`, `"accept-edits"`, `"plan"`,
  `"bypass-permissions"`, or a pass-through).

## Feed channel

`subscribe_feed(on_batch: Channel<FeedBatch>) -> ()` — called once on mount (and again after a
webview reload; the Rust side replaces the stored channel). Batches flow only after this call.

```
FeedBatch {
  project_id: string,
  rows:     FeedRowWire[],       // terse rows, in seq order per session; [] when the project is not visible
  signals:  Envelope[],          // always delivered regardless of visibility (see list below)
  counters: SessionCounter[],    // one per session touched in this frame
}
FeedRowWire   { s: string /*session_id*/, q: number /*seq*/, t: number /*at_ms*/, l: string /*line*/ }
SessionCounter{ session_id: string, rows_total: number, rows_dropped: number }
```

- One batch per animation frame (16 ms tick in Rust) per project; an empty frame sends nothing.
- Serialized size of every message is asserted `< 8000` bytes before `send`; a frame that does not
  fit is split into several messages, at most 24 rows each (`feed-rendering.md` §4).
- Signal envelopes are sent with `raw` stripped (`raw: None`): one envelope with a raw excerpt
  measured 4 279 bytes, two alone cross the 8192-byte cliff (`tauri-commands.md` §9).
- Signal events are the envelopes whose `event.type` is one of: `session-started`,
  `session-exited`, `turn-started`, `turn-completed`, `turn-aborted`, `request-opened`,
  `request-resolved`, `session-compacted`, `runtime-error`, `runtime-warning`. Everything else is
  represented only by its terse row (`feed::terse_line`) or not at all.
- `set_visible_projects(project_ids: string[]) -> ()` — rows for projects not in the list are
  dropped in Rust and counted in `rows_dropped`; signals still flow.

## Commands

| command | args | returns |
|---|---|---|
| `app_info` | — | `AppInfo { run_id, data_dir, version }` |
| `probe_claude` | — | `ClaudeStatus { binary, version }`; error `claude_not_installed` / `claude_too_old` |
| `list_models` | — | `ModelInfo[]` `{ id, label, default: boolean }` (fixed list, from research) |
| `list_projects` | — | `ProjectView[]` |
| `add_project` | `path: string` | `ProjectView` (path must be an existing directory; `invalid_argument` otherwise) |
| `list_sessions` | — | `SessionView[]` newest first |
| `start_session` | `project_id, prompt: string, model: string \| null, permission_mode: string` | `SessionView` |
| `send_turn` | `session_id, text: string` | `{ turn_id: string }` |
| `respond` | `session_id, request_id, decision: Decision` | `()` |
| `interrupt` | `session_id` | `()` |
| `end_session` | `session_id` | `()` |
| `kill` | `session_id` | `()` |
| `feed_tail` | `session_id, n: number` | `FeedRowWire[]` oldest first |
| `pending_approvals` | — | `ApprovalView[]` oldest first |
| `record_frame_stats` | `stats: FrameStats` | `()` (appends one NDJSON line to `<data_dir>/frame-stats.ndjson`) |
| `burn` | `sessions: number, rows_per_sec: number, duration_s: number, fixture: string` | `()` (dev builds only; replays fixtures through the feed channel) |

```
AppInfo      { run_id: string, data_dir: string, version: string }
ClaudeStatus { binary: string, version: string }
ModelInfo    { id: string, label: string, default: boolean }
ProjectView  { id: string, name: string, root_path: string, created_at_ms: number }
SessionView  { session_id, project_id: string|null, instance_id: string|null, provider_session_id: string|null,
               cwd: string|null, model: string|null, status: "starting"|"running"|"exited"|"failed",
               started_at_ms: number|null, ended_at_ms: number|null, exit_code: number|null,
               last_event_seq: number, usage: Usage, cost_usd_cumulative: number }
Usage        { input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens: number, context_window: number|null }
ApprovalView { request_id, session_id: string, opened_at_ms: number,
               kind: RequestKind | null /* null when the store replaced an oversized kind_json */,
               expired: boolean /* no longer answerable: run_id != current OR the session is no longer live */,
               resolved: boolean /* always false today: `pending_approvals` filters
                                   `resolved_at IS NULL` (crates/supervisor/src/lib.rs:461-472);
                                   kept for shape stability, not read by the UI */ }
Decision     { type: "allow", updated_input: unknown|null, updated_permissions: unknown[] }
           | { type: "deny", reason: string, interrupt: boolean }
FrameStats   { window_start_ms: number, hz: number, frames: number, dropped: number,
               p50_ms: number, p95_ms: number, p99_ms: number, worst_ms: number,
               longest_drop_run: number, dom_nodes: number }
```

## Browser fallback

`src/bridge.ts` detects Tauri via `isTauri()` from `@tauri-apps/api/core`. Outside Tauri (plain
`npm run dev` in a browser) it serves an in-memory mock: two projects, one running session, a
synthetic batch generator at a configurable rows/sec, and approvals that resolve locally. The mock
exists so the front end can be developed and its FPS meter exercised without the Rust side, and it
must implement this same contract.
