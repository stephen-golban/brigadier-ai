# Native Changes and embedded VS Code Search

Updated 2026-09-08 after reviewing the first integration with the owner.

## Changes panel

The Changes panel uses Brigadier's own components, typography, icons, menus, and colors. `src/components/SourceControl.tsx` owns the repository UI, `ChangesFileList.tsx` renders the list/tree, and `CommitPreferences.tsx` contains the existing preferences.

The layout follows the agreed VS Code structure: header and branch context, commit message with Generate, split Commit button, then collapsible Staged Changes/Changes groups. File actions appear on hover or keyboard focus. Flat list is the default; the menu offers tree view and name/path sorting. Clicking a file opens its diff; the file action opens the regular editor.

Included commands: stage/unstage/discard, commit/amend, commit and push, pull/push/fetch, branch checkout, stash/apply/pop. Clone, remote management, tags, and rebase are not exposed. Session Changes, Turn Changes, Apply to Project, and all Review Working Changes controls remain excluded.

The `@codingame/monaco-vscode-scm-service-override` package, embedded SCM provider, Git command contributions, and registration are removed. Opening Changes does not load the VS Code runtime. Existing Rust Git operations remain shared backend functionality.

Commit drafts are keyed by project and session. Pending generation and commits retain their originating session. Cancellation does not change smart-commit preferences. A successful commit clears its draft before a subsequent push, so a push failure cannot leave a committed message ready for accidental reuse. Failed commits preserve the draft. Discard and amend require confirmation through Brigadier's existing dialog.

## Search panel

Search continues to use the actual VS Code workbench components distributed by CodinGame's `monaco-vscode-api`, with all related packages pinned to 36.2.7. The runtime is lazy-loaded by `VscodePanels.tsx`. Normal result navigation opens Brigadier tabs; the upstream Search Editor opens in its own editor overlay.

`src/vscode-panels/workspace.ts` provides the filesystem and search adapter. Every project/session has a distinct URI authority, replacement saves check their before-images, and cancelled searches discard late results. UTF-16 ranges, multiline matches, glob alternatives, ignore settings, and open-file scope are supported. Search Editor context lines use the same workspace API. The changed-files filter now reads Brigadier's status through the read-only `ChangedFilesIndex` adapter and no longer requires the VS Code Git panel.

The existing Rust regex engine and file/result limits remain; unsupported look-around/backreferences return an error. This is not complete parity with VS Code's optional PCRE2 engine.

## Maintenance and verification

Keep the remaining `@codingame` packages at the same exact version. Vite excludes them from prebundling to preserve theme asset URLs and service identity. The QueryBuilder and EditorService adapters need checking on upstream upgrades. Development updates reload the page because the VS Code services cannot initialize twice.

Production Search runtime after removing SCM: approximately 9.45 MB JavaScript / 2.43 MB gzip, plus assets. Changes uses only Brigadier's normal UI dependencies. Upstream notices ship at `public/vscode-panel-notices.txt`.

Validation covers native panel structure, stage/discard behavior, smart-commit cancellation, successful commit followed by failed push, failed commit draft retention, session isolation during generation, tree view, branch checkout, host refresh/workspace switching, and Search adapters. Full frontend tests and production build pass. Browser verification uses the local fixture backend; no Git mutations are performed on the user's repository.

Sources: [CodinGame service overrides](https://github.com/CodinGame/monaco-vscode-api/wiki/List-of-service-overrides), [integration project](https://github.com/CodinGame/monaco-vscode-api).
