# Owned worker completion correction

Native verification found that a parent returning after a worker requested approval remained idle when the approved worker finished. The existing feed notifier only released an active `wait_sessions`; no completion work receipt woke an idle owner.

Current live `TurnCompleted` signals now create a durable receipt keyed by owned worker and turn. The existing peer delivery path queues one owner continuation, respects Stop/archive/availability/project-message gates, and never resumes an ended or stopped parent. The notification requests continuation of the existing task and labels worker output as reference data without additional authority. It is bounded to the existing 64-message parent queue and rejects ownership cycles. Initial loading/import never scans historical turns. Restart retains receipts and marks undelivered work failed/unknown instead of replaying it.

`read_session` and `wait_sessions` record completed results returned to the owner. An observed completion suppresses the extra wake, including a read racing signal delivery. Stop cancels queued work; a delayed pre-Stop completion signal also records cancellation so an explicit later Resume cannot revive that notification.

The sidebar attention dot also represented unread completed output, not just approvals. Viewing a worker in the right pane now marks only that worker's displayed sequence read. Live idle workers with completed turns display **Awaiting integration**; real pending approval takes precedence, then Working/Starting. Closed/exited workers remain Done.

Retirement previously cleaned up immediately after a kill acknowledgement, racing the consumer's durable exit. It now waits up to five seconds for the live registry to clear before safe cleanup. A transient cleanup failure can retry on read/close. Cleanup remains `force:false`: uncommitted work and shared workspaces remain retained, as do histories and branches.

Focused validation:

- `cargo test -p brigadier --lib peer`: 21 passed. Includes production delivery-loop integration using controlled provider actors and real supervisor/store: queued child work, accepted-but-working child, busy parent, one eventual send, duplicate dispatch, read/wait suppression, Stop cancellation and no resume of ended parent. No model calls are used by those actors.
- Attention, worker tree/panel and feed tests: 36 passed across 4 files.
- TypeScript no-emit and `git diff --check`: passed.

Crash semantics remain the existing conservative model: an ambiguous delivery is unknown and is not automatically retried. This does not claim exactly-once execution across a process crash. Native wake-once, observed-result suppression, Stop suppression, and safe retirement acceptance are owned by the source task after rebuild; no installed app/data were edited here.
