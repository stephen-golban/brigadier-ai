# Wry drag-drop crash during startup gate

Checked 2026-09-11. Research only; no code or dependency changes.

## Finding

The failed run hit a known Wry macOS pasteboard bug, not a measured startup-duration failure. The [local run log](/tmp/brigadier-release-20260911/startup-fresh-session.run-1.log) ends with unresolved file-reference URL / empty pasteboard warnings, followed by `Option::unwrap()` panicking at Wry 0.55.1 `drag_drop.rs:24:63`. Its last startup trace is `supervisor_new` at 172.653 ms; no successful startup result exists in this log.

At that line, Wry assumes that advertising `NSFilenamesPboardType` guarantees a non-null property list. The subsequent array and string casts also unwrap. `collect_paths` is called only by the drag-enter and perform-drop handlers in this module. Therefore a native drag callback reached file collection; the log does **not** identify the drag source, prove a deliberate external/user drag, distinguish enter from drop, or include a backtrace. “External file drag interrupted the run” is stronger than the evidence supports. [Wry source at current upstream revision](https://github.com/tauri-apps/wry/blob/792d0359ba6501a4fc360ece17de2ae42329a47c/src/wkwebview/drag_drop.rs#L18-L31)

## Upstream status

- [Issue #1756](https://github.com/tauri-apps/wry/issues/1756) remains open. An [August report](https://github.com/tauri-apps/wry/issues/1756#issuecomment-5375199890) contains the same file-reference URL warning, empty pasteboard warning, and exact Wry 0.55.1 panic location as this run.
- [PR #1723](https://github.com/tauri-apps/wry/pull/1723) remains open and unmerged (head `4bd42c27b30ad00bf1679f2b648aed137231cfe3`). It replaces the primary legacy read with `readObjectsForClasses:options:` using `NSURL` and makes the legacy fallback tolerate missing/wrongly typed values. Its author reports native tests with modern `public.file-url` sources. That is author-reported validation, not validation in Brigadier.
- The latest release is [0.57.0, published September 8](https://github.com/tauri-apps/wry/releases/tag/wry-v0.57.0). Its [drag-drop implementation](https://github.com/tauri-apps/wry/blob/wry-v0.57.0/src/wkwebview/drag_drop.rs#L18-L31) still has the failing unwrap. Upgrading to that release does not fix this bug.

## Recommendation

Retain this failed run as crash evidence and rerun the unchanged native gate with no drag interaction, preferably with `RUST_BACKTRACE=1`. Do not count the crash as a passing sample or alter startup timing boundaries. If the crash recurs during untouched startup, pursue a narrowly scoped, repository-pinned pasteboard fix and native validation; a broad Wry upgrade is unsupported by the findings. The unmerged PR is a useful implementation reference, not an already shipped remedy. Avoid disabling drag-and-drop solely to make the benchmark pass.
