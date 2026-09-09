# Installed macOS verification — 2026-09-09

Built from the implementation working tree `/Users/stephen/.codex/worktrees/258b/brigadier-ai`, not its unchanged base HEAD (`289f63d0cb131ee8cbf62cc7494ed0183295462a`). The source changes were uncommitted at build time; subsequent commit preparation is recorded below.

## Installation

- Release command: `PATH="/Users/stephen/.cargo/bin:$PATH" npm run tauri -- build --bundles app`.
- Installed destination: `/Applications/Brigadier.app`, identifier `ai.brigadier.app`, version `0.1.0`.
- Bundle was locally ad-hoc signed and passed `codesign --verify --deep --strict` before replacement.
- Old application and complete app-data backup: `/Users/stephen/Library/Application Support/Brigadier Backups/20260909-153309`.
- Existing brigadier-ai and Tuppi projects and conversations loaded successfully after replacement. User project source files were not modified for verification.
- Initial native-verification binary SHA256: `5798b591134c2474755291cabff7f0ee285a5df95b1b65731064b2a1073ae9eb`. A later corrective build, if needed, is recorded below.

## Native checks completed

The installed app was driven through macOS accessibility/keyboard UI. A disposable repository was imported through the native folder chooser: `/private/tmp/brigadier-native-verification-20260909`.

- New-session composer accepted ordinary draft text.
- Pasted 18,600 Unicode/CRLF characters into that draft: generated a `pasted-text-*.txt` attachment without replacing draft text. Read-only database comparison confirmed all 21,000 UTF-8 bytes, including CRLF, exactly match the clipboard fixture.
- Native file-picker attachment: `binary-fixture.bin`. Read-only database comparison confirmed all eight original binary bytes.
- Native clipboard image paste: copied pixels from Preview, pasted into composer, resulting in a PNG attachment.
- Native Finder file copy/paste: copied the binary fixture in Finder and pasted into composer. A separate eight-byte attachment was created with exact original bytes.
- Created and saved a project note with marker `NOTE-9042`; selected it using the `@` suggestion picker. Selected README using the same file/note picker; it created a file snapshot plus reference chip.
- Draft and attachments survived navigating away to the note editor and back.
- File and note references remained visible in sent history. The resumed Codex agent correctly read `NOTE-9042` and the README test command.
- Typed Markdown bold shortcut; native composer visibly rendered bold text.
- Context card opened with worktree, branch, changes and sources. Its Subagents action opened the shared right workspace pane.
- Stop paused the task and queue. After quitting and relaunching the app, the task remained stopped and the complete unsent draft remained. Explicit Resume enabled Send.
- Enter while working enqueued a follow-up with inspect/edit/remove controls.

## Defects caught during native verification

The first default-permissions Codex run could stream and request command/file approvals, but rejected `mcpServer/elicitation/request` requests before showing an approval. This blocked checkpoint, attachment catalog and provider catalog calls and therefore prevented delegation. The adapter emitted `Unsupported Codex request ...`; the provider reported a user rejection even though the user never rejected these calls. Raw evidence: session `545e2b81-c5e7-4c22-bb12-9394e6564864`, sequences 85, 94, 100.

Stopping while a file approval was open also left a stale Waiting on you card/sidebar attention state. Both findings were assigned to the implementation task for correction before final installation verification.

## Scope limits

Native Finder drag/drop has not yet been exercised; synthetic Tauri native-drop routing tests passed in the implementation suite. This is not an exhaustive soak test, universal provider-format comprehension test, or a performance benchmark. Earlier acceptance logs independently inspected: Rust 687 passed/0 failed/10 ignored across 33 suites; frontend 454 passed across 56 files; production frontend build passed.

## First corrective build

The MCP approval fix passed 17 adapter tests (two opt-in live tests ignored), 33 approval UI/feed tests, four store-approval tests, TypeScript and whitespace checks. Rebuilt and reinstalled; signed executable SHA256 `f0c6c24d85da4a671d4c4cf438d43981365bd907e6a6c9389485cb91a8ac45b6`.

On native relaunch, the old stopped Edit approval and sidebar attention cleared. The edited queued retry and rich draft/binary attachment survived replacement and restart. Resume then exposed a separate discovery issue: `no driver registered for codex`. Read-only inspection of the actual installed process showed normal LaunchServices PATH `/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin`, whereas this machine's Codex resides at `/Users/stephen/.local/bin/codex`. The Codex probe searched only PATH. Assigned robust native CLI discovery correction to the implementation task; no shell profile/global PATH changes made.

## Final discovery build and normal-launch check

Shared CLI resolver correction passed nine binary-resolution tests and the 17-test Codex adapter suite. Release build passed and was installed/ad-hoc signed with executable SHA256 `4e9a32841a07a49b688d1962dde3971bddae2d0c2e50b640de95c2065948da45`.

Quit the app, selected `/Applications/Brigadier.app` in Finder and opened it through Finder. Read-only process inspection confirmed its PATH was only `/usr/bin:/bin:/usr/sbin:/sbin`. The app discovered Codex, restored the stopped conversation and edited queue, and Resume dispatched the single queued retry successfully. The fixture tests were independently run before delegation and failed both expected cases, establishing a real before/after verification target.

## Real mixed-provider execution

The resumed Codex task successfully approved/read checkpoint, connected providers and attachment catalog through the corrected native MCP cards. It created Claude worker `5d8aa76f-2bb1-44e4-bcf6-ac7772225f0b` (`claude-opus-5[1m]`, low effort), with separate worktree `d7248df9`. The Subagents pane opened the worker conversation while keeping the parent visible. Native worker Edit approval applied the intended one-line change; both fixture tests then passed independently in the worker worktree.

A direct message from the right-panel composer queued and delivered exactly once to the worker, which returned `WORKER-UI-9042`. The parent received a bounded Task owner notification containing that direct intervention.

A further orchestration issue surfaced: the parent had yielded while the worker needed an Edit approval. After approvals were granted and the worker completed, no automatic completion wake resumed the parent. The worker also displayed stale Needs attention/Waiting despite all three approvals having durable resolutions and both turns completing. Assigned diagnosis/correction to implementation task. A manual parent follow-up was used to verify integration/cleanup independently; it is not evidence that automatic completion wake already works.

After the explicit parent follow-up, Codex read the worker result with a cursor, compared its file, and integrated the one-line change into parent worktree `dcc8f707`. Independent verification there: `python3 -m unittest -v` passed both cases; `git diff --check` passed; only `feature.py` changed (+1/-1). The imported project's original checkout remained unchanged. Native parent test/diff approval cards were also approved to verify its own result path.

Parent completed its own tests and durable 4/4 checklist; closed worker appears under Done · 1. The retirement record retained the worker worktree with reason `session ... is still live; end it before cleaning up its worktree`, indicating termination/cleanup timing needs checking. No worktree was force-deleted. Parent result and markers are persisted. A read-only automatic-wake verification prompt was saved as a draft, and the app was quit awaiting the lifecycle correction.

## Lifecycle correction and remaining native acceptance

The implementation task corrected owned-worker completion wake, right-panel read/attention status, and the retirement timing race. Focused validation: 21 Rust peer tests, including the production delivery loop with real supervisor/store and controlled actors (busy parent, queued/working child, duplicate/observed result suppression, Stop cancellation and ended-parent refusal); 36 UI/feed tests across four files; TypeScript and whitespace checks passed. Details and conservative crash semantics are recorded in `WORKER-COMPLETION-FIX.md`.

The Mac locked during verification and native automation could not unlock it. The user was asked to unlock it. Release packaging/replacement can proceed with the app already quit; the prepared native automatic-wake prompt remains unsent. The last lifecycle correction's positive automatic-wake/Stop/clean-retirement UI test and real Finder drag/drop remain unverified until an unlocked desktop is available. Prior native composer, normal-launch, mixed-provider coding, integration, direct-message and restart checks above were actually exercised.

Final lifecycle build installed and signature verified: `/Applications/Brigadier.app`; executable SHA256 `9c637330db10b1964fd4420255a2c11968d188dcf5a31d9aab4a7a020acb1a55`. Installed/source signed executables match. Previous binary retained as `pre-completion-fix.app` in the original backup directory.

## Commit preparation

Behavior-preserving Clippy cleanup removed redundant whitespace trimming and test borrows, and passed the existing SpawnIn workspace descriptor into the internal session helper. Fresh checks: Rust 747 passed / 0 failed / 10 ignored; frontend 461 passed across 58 files; Clippy with warnings denied, rustdoc, TypeScript, whitespace validation and release app build passed. The native burn and remaining lifecycle GUI checks could not run on the locked Mac.

Replaced the installed app with this commit-preparation build; signature verified. Executable SHA256 `1f51ae1daf3de1680c8f359027cf0cda5182d345fc01af38d8aaf0cefc9291c0`. Earlier build retained as `pre-commit-cleanup.app` in the backup directory.
