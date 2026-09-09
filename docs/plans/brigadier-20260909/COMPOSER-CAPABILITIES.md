# Composer capability check — 2026-09-09

User clarification: support clipboard paste, drag/drop and picker attachments for images and other files, file AND note mentions, formatting, and automatic conversion of huge pasted text to an attached text file. Compare Tiptap as well as Lexical. This extends the approved composer implementation. No runtime validation has been performed in this research task; implementation agents must test the integrated native app.

## Revised recommendation

Use Tiptap as the rich input editor with assistant-ui continuing to own conversation rendering/runtime integration, unless a focused implementation check demonstrates a better fit with custom Lexical. This is a change from the preliminary assistant-ui Lexical-wrapper recommendation, based on inspecting published source rather than just documentation. It does not revive the cancelled BB port.

Lexical itself is capable of rich text and custom event handling. However @assistant-ui/react-lexical 0.2.12 (npm latest inspected today, paired with @assistant-ui/react 0.15.18) hardcodes PlainTextPlugin and only DirectiveNode in its custom node configuration. Its SyncPlugin rebuilds paragraphs from runtime strings and reads textual content/directives, not a general rich Markdown document. Adding a MarkdownShortcutPlugin child alone is not a complete rich-text solution. A custom Lexical composer needs rich nodes, plugin configuration and proper serialization, not just styling. Also its Enter handler declines submit while isRunning; queue integration cannot simply reuse that behavior.

## Comparison

| Requirement | Lexical / assistant-ui integration | Tiptap | Brigadier responsibility |
| --- | --- | --- | --- |
| Images/files through paste | Lexical command/plugin or explicit paste handler; generic assistant-ui textarea paste code is not inherited by LexicalComposerInput | FileHandler onPaste exposes files | Persist bytes/metadata, stage previews, surface errors, deliver through adapter |
| Images/files through drag/drop | assistant-ui AttachmentDropzone can stage files outside editor, or custom Lexical drop handling | FileHandler onDrop | One owner of drop event; native Tauri path drops may need app bridge |
| Picker attachments | assistant-ui AddAttachment or native picker | App picker feeding attachment staging | Same storage and delivery path as paste/drop |
| File and note mentions | assistant-ui supports custom categories/items and Lexical directive chips | Mention extension plus Suggestion data callbacks | Search real files/notes; stable project-scoped IDs and actual content resolution |
| Formatting | Lexical framework supports plugins/nodes; current assistant-ui wrapper is plain-text-first | StarterKit supplies marks, lists, code blocks, undo/redo | Preserve formatting/code/mentions across draft, queue, send and reload |
| Huge text paste as file | Custom paste interception | Custom paste interception (FileHandler alone handles files, not this text policy) | Threshold, exact clipboard text saved as .txt, attachment chip/preview/recovery |
| Durable queue / pause / resume / steer | Custom app runtime integration | Custom app runtime integration | Backend state, acknowledgments, idempotency, stop semantics |
| CLI commands | Trigger popovers are UI only | Suggestion/custom slash extension is UI only | Supported provider command discovery, arguments and real execution |

The assistant-ui textarea currently has an explicit addAttachmentOnPaste handler, while its Lexical wrapper does not install that handler. Do not assume generic assistant-ui attachment documentation proves Lexical clipboard support. Its separate AttachmentDropzone uses onDropCapture and addAttachment. Avoid registering a second editor handler that duplicates staging.

Tiptap FileHandler explicitly handles paste/drop events but does not upload/store files. The Mention extension accepts custom suggestion sources; it does not know Brigadier files or notes. Markdown parsing/serialization extension docs are marked Beta; pin a tested version, verify custom mention serialization and literal code round-trips. No paid/cloud Tiptap service is required for these core editor behaviors; check actual package licenses on selection.

## Required acceptance behavior

1. A clipboard screenshot, dragged image, picked image and mixed file batch all produce real attachments. Test actual Tauri WebView/native drag paths in addition to browser synthetic events. Clipboard file behavior is conditional on the OS exposing file data; plain file paths must not be confused with bytes. No navigating the WebView away or double imports.
2. @ opens Files and Notes results backed by real project data. Duplicate labels keep distinct stable IDs. Selection survives draft/queue/send/reload and provider input receives the referenced material or usable reference. A pretty chip with missing backend context fails acceptance.
3. Formatting covers the intended compact prompt features (bold/italic, lists, links, inline/fenced code). Undo, IME and code whitespace survive. Serialization must not flatten marks using getText() or corrupt literal paths/code while applying typography.
4. Intercept oversized plain-text paste before normal rich HTML insertion. Stage a .txt attachment preserving the text supplied by the clipboard without truncation or typography conversion, show its name/size and preview, and keep the user's existing draft. A reasonable starting threshold is an implementation choice (e.g. 8,000 characters); centralize and boundary-test it instead of asking the user for an arbitrary number. Show conversion feedback, with a recovery/undo or paste-inline option if practical. Do not silently drop text if attachment persistence fails; retain it for retry. Large ordinary typing does not unexpectedly become a file.
5. Pasted rich HTML may include a plain-text alternative: large-paste conversion must run early enough to prevent a huge DOM and double insertion. File-containing paste should be classified deliberately so text conversion and file import do not duplicate the same content. Test Unicode, CRLF, code/log blocks, multi-megabyte input, storage limits and import failure.
6. Every path uses the same durable attachment pipeline, queue entries snapshot attachment/reference IDs, and workers receive valid content when delegated. Test navigation/restart, pending imports, failed sends, queue drain/manual-send races and Stop pausing the queue. Accepted is not delivered; no duplicate retries on unknown outcomes.

## Primary sources inspected

- Published npm source: https://registry.npmjs.org/@assistant-ui/react-lexical/0.2.12 (dist archive source files inspected), https://registry.npmjs.org/@assistant-ui/react/0.15.18
- https://github.com/assistant-ui/assistant-ui/blob/main/packages/react-lexical/src/LexicalComposerInput.tsx
- https://github.com/assistant-ui/assistant-ui/blob/main/packages/react-lexical/src/plugins/SyncPlugin.tsx
- https://www.assistant-ui.com/docs/guides/mentions
- https://www.assistant-ui.com/docs/guides/attachments
- https://lexical.dev/docs/concepts/commands
- https://lexical.dev/docs/packages/lexical-markdown
- https://tiptap.dev/docs/editor/extensions/functionality/filehandler
- https://tiptap.dev/docs/editor/extensions/nodes/mention
- https://tiptap.dev/docs/editor/extensions/functionality/starterkit
- https://tiptap.dev/docs/editor/markdown/getting-started/basic-usage

URLs to main are moving references; npm versions above identify the inspected release. These findings establish implementation seams, not that the finished Brigadier composer already passes them.
