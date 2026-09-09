# Composer implementation evidence

Owner: composer worker. Updated 2026-09-09.

## Delivered

- Pinned `@assistant-ui/react` 0.15.18, `@assistant-ui/react-lexical` 0.2.12, direct Lexical packages 0.49.0. Installed source confirmed wrapper's plain-text-only node configuration and textContent synchronization. Custom `RichPromptEditor` reuses assistant-ui DirectiveNode/DirectiveChipProvider with Lexical rich nodes, history, list and Markdown plugins. No hosted service or gateway.
- Exact-source adapter handles rich bold/italic/strike/code, headings, lists, quotes, links and reference chips. Reload parses rich Markdown only if serializing it reproduces the original source exactly; otherwise it keeps literal source. This protects paths, blank lines and code from normalization. Pasted HTML uses the plain-text alternative. IME Enter is consumed by the editor without submitting; plain Enter submits or selects suggestions; Shift+Enter adds a line.
- Project-file and note mentions resolve real workspace/note data. File mention imports a snapshot with original project-relative path in the content and inserts a durable attachment identity. Async results cancel on query/scope changes. Attachment removal also removes associated mention tokens.
- One attachment pipeline for picker, DOM drop, clipboard files, and native Tauri path drops. Native events are hit-tested to the target composer so root/worker editors do not both import. Metadata/size/preview and removal supported. Huge paste threshold is centralized at 16,000 characters; larger text stages exact clipboard bytes as a `.txt` file, preserving the existing draft. Import failure retains bytes for Retry. Successful parts of a mixed batch are not reimported on retry.
- `composerApi.ts` owns the typed desktop contract. `useDurableComposer` saves drafts and attachment identities to backend state for sessions and `project:<projectId>` scopes, uses a local pending-write recovery copy, and serializes writes per session across React remounts.
- All existing-session normal submissions use backend enqueue. The stable logical request ID is cached until acknowledged and reused after an ambiguous reply/remount. Queue snapshots are revision-checked. Entries survive navigation/restart, can be inspected/edited/removed before send, and unknown outcomes require explicit delivery reconciliation. The single primary button switches Send/Stop; while working, Enter queues follow-ups. Stop bypasses draft writes and pauses queue; Resume is explicit and uses backend resume exactly once.
- Slash suggestions reflect real adapter controls: `/stop`, `/context`, Codex native `/compact`, and Claude command/skill entries advertised by the initialized session with argument hints; choosing inserts and sending executes. Unknown commands/unsupported arguments are rejected visibly and never become ordinary prompts. Steer is absent because the adapter has no verified in-flight steering path.
- Ongoing composer shows exact model, effective effort/permissions when reported, current context and observed allowance waiting. Unknown reset remains unknown.

## Checks

- `npx tsc --noEmit`: passed.
- `npm run build`: passed (existing large-chunk warnings).
- `npm test -- src/components/composer src/components/PromptInput.test.tsx src/components/Dock.test.tsx src/components/Dock.rewind.test.tsx src/components/ArchiveSettings.test.tsx`: **41 passed** (7 files).
- Tests cover formatting/links/lists/fenced code/source preservation, marks with reference-chip reload, undo, IME, stale mention cancellation, real attachment import payloads for paste/drop/picker, huge Unicode/CRLF/code paste bytes and preview/retry, file and note identities, queue stop/restart/resume, unsupported controls, persistent uncertain request identity, blocked draft-write Stop, serialization after failures, old rewind safety and starter caret placement.
- jsdom lacks native contenteditable editing. `src/test/composer.ts` exercises Lexical's actual paste command and supplies normal keyboard events for navigation/submit. `src/test/setup.ts` adds only selection-geometry shims. Integrator additionally confirmed live browser starter caret appends correctly. Native typing and native drag/drop still require integrator UI smoke verification; these are not claimed as tested by synthetic events.

## Known bounds

The integrated backend supports decoded images, UTF-8 text, and generic binary files (5 MiB image/binary; 1 MiB text). Generic original bytes are durable and materialized at an app-owned local path; provider delivery describes file access without promising format comprehension. Codex also retains native file-reference copies across End/resume. Store binary forwarding/restart and Codex native binary reference tests pass. No fake universal CLI commands or unsupported Steer controls. Editor history is deliberately reset on an external draft change so Undo cannot cross conversations.


## Integrated acceptance evidence (root update)

- Clipboard image and file paste, DOM file drop and picker use the same byte-preserving import function: `attachments.test.tsx` checks decoded outbound bytes and durable IDs. These are DOM/IPC-mocked tests, not native OS clipboard verification.
- `PromptInput.tsx` subscribes to Tauri `onDragDropEvent`, scales physical coordinates, hit-tests the individual composer, calls `import_conversation_attachment_path`, and ignores stale destinations. Native path event routing receives a dedicated synthetic integration test; real Finder drop is still pending an unlocked Mac.
- File and note mention tests verify distinct typed durable identities, exact file snapshot bytes, chip serialization/reload and stale lookup cancellation. Backend note contextualization tests validate note scope/content; store attachment tests verify send references/reload. These are component/backend-layer checks, not one full native send-through-reload interaction.
- Rich marks, links, lists, fenced code, literal whitespace/paths, undo and IME are covered by `RichPromptEditor.test.tsx`. The custom editor uses Lexical RichTextPlugin with explicit nodes and source serializer, never the stock plain wrapper's PlainTextPlugin or textContent SyncPlugin. It reuses assistant-ui directives and composer surfaces; Tiptap is unnecessary because the custom Lexical adapter supports the required node/serialization surface.
- Huge paste (>16,000 characters) preserves Unicode, CRLF and fenced source exactly in imported `.txt` bytes; failure retains the original `File` for Retry, and the existing draft is unchanged. 16,000-character boundary stays inline.
- Durable queue tests preserve attachment IDs on restart/unknown delivery and retain logical request IDs; store tests retain original binary bytes across cross-project forwarding and restart. Native whole-flow attachment/queue smoke remains pending.
- Steer is not exposed: no verified in-flight steering path. This does not claim full screenshot parity.


Final integration additions: native drop synthetic2/2 checks target hit-testing and stale completion; saved user-history test verifies rich formatting plus file/note reference resolution after remount; attachment-only initial-send regression covers huge paste from an empty draft. Opaque binary previews offer the original download rather than decoding arbitrary bytes as text. Leading absolute file paths remain prompts. Native controls were live-tested: Codex compact emitted manual compaction; a temporary Claude advertised command received exact arguments and returned the expected marker. Native terminal-only commands without an API equivalent remain absent.
