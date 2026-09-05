# Local chat and workspace IPC

Implemented 2026-09-05. This extends `ipc-contract.md`. All UI argument keys are camelCase; Rust command names remain snake_case. All failures use the existing `AppError {code,message}` shape. There is no remote execution argument.

| Command | Arguments | Result |
| --- | --- | --- |
| `start_session` (extended) | Existing fields, optional `options: {effort?: "auto" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"}` | Existing session view. Unknown option fields and unsupported effort/model combinations fail. Interactive chat inherits model thinking defaults. |
| `chat_items` | `sessionId`, `after` (exclusive event sequence, initially 0) | Up to 20 `{session_id,id,seq,at,kind,body,parent_id}` items, ordered by sequence. `at` is Unix milliseconds. Kind uses the existing `ItemKind` discriminator. |
| `workspace_entries` | `projectId`, optional `sessionId`, `path` (relative, empty for root) | Up to 2,000 `{name,path,directory}` entries, folders first. |
| `workspace_file` | Same context, `path` | `{path,content,truncated}`. Text capped at 512 KiB. |
| `workspace_git` | `projectId`, optional `sessionId` | `{branch,changes:[{path,index,worktree}]}`. Status letters follow Git porcelain v1. |
| `workspace_diff` | Same context, `path`, `staged` | `{path,content,truncated}`. Untracked files return bounded text. Deleted paths are supported. |
| `terminal_open` | Same context, `cols`, `rows` | Opaque terminal ID. Creates a login shell in the resolved workspace. |
| `terminal_read` | `id` | `{data:number[],exited:boolean,dropped:number}`. Bytes preserve split UTF-8 sequences. Reads drain up to 8,192 bytes. `exited` requires both child exit and output-reader completion. |
| `terminal_write` | `id`, `data` | Unit. Input is capped at 64 KiB per call. |
| `terminal_resize` | `id`, `cols`, `rows` | Unit. Dimensions clamped to 10–500 columns, 2–500 rows. |
| `terminal_close` | `id` | Unit, idempotent. Releases the PTY and terminates/reaps the shell. |

Workspace roots are resolved from registered rows. A session must belong to the supplied project. The session cwd takes precedence over the project root. Canonical paths must remain within that root; arbitrary absolute preview paths are rejected. The renderer converts recognized absolute workspace links into relative paths before IPC.

Chat body projection is stored by schema version 7, separate from the 500-row telemetry ring. Bodies are capped at 128 KiB and retained for the newest 2,000 items per session. Stable IDs are upserted only for newer sequence values. The chat write advances `last_event_seq` in its transaction. Parent IDs and tool-result correlation survive persistence. Session deletion cascades to this table. No migration fabricates historical full bodies from terse summaries.

The PTY registry allows 12 terminals per app process. Each has a 1 MiB rolling byte buffer. The app shutdown path clears the registry even when there are no agent sessions. Hidden terminal tabs remain mounted; closing a tab or deleting its owning workspace releases it. Terminals are not recovered after restarting the app.
