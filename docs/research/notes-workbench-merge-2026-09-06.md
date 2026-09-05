# Integrating the Notes worktree

Verified against official Git documentation on 2026-09-06. This is procedural research; no repository was modified by the researcher.

1. Commit the authorized changes on main before merging. Git recommends committing or stashing beforehand; overlapping dirty changes can block a merge, and abort may fail to reconstruct pre-existing uncommitted edits. [Git merge: pre-merge checks and abort](https://git-scm.com/docs/git-merge)
2. In the detached source worktree, use `git switch -c <unused-branch-name>` at its existing HEAD, then commit its intended changes. Git explicitly supports naming useful detached work this way. Avoid `-C`, which can reset an existing branch. [Git switch](https://git-scm.com/docs/git-switch)
3. Stage only source, tests, and intended documentation. `git add -u` stages tracked modifications/deletions without adding untracked files; explicit path arguments can then add reviewed new files. Unqualified `git add -A` includes all unignored new files, so it would capture the private `work/` backups unless excluded. Inspect the staged paths before committing. [Git add](https://git-scm.com/docs/git-add)
4. From clean main, use `git merge --no-ff --no-commit <source-branch>`. `--no-commit` alone cannot pause a fast-forward, while `--no-ff` guarantees a reviewable merge commit. [Git merge options](https://git-scm.com/docs/git-merge)
5. Resolve overlapping additions by examining both versions, retaining existing main fixes and incorporating Notes behavior. During a merge, index stage 2 is main/HEAD and stage 3 is the source/MERGE_HEAD. Edit resolutions, then explicitly `git add` each resolved path; finish with `git commit` or `git merge --continue`. [Git merge conflicts](https://git-scm.com/docs/git-merge)
6. Inspect `git diff --cached` and run `git diff --cached --check` after staging. Plain `git diff --check` compares working files with the index and can miss already staged defects. `--check` detects introduced conflict markers and configured whitespace errors, exits nonzero for problems, and does not test correctness. [Git diff](https://git-scm.com/docs/git-diff)

Practical caveats (recommendations inferred from these mechanics): do not resolve an entire overlap using blanket ours/theirs; inspect staged new files for private app/database backups; confirm no unmerged paths remain; run appropriate application tests before recording the merge. Excluded untracked `work/` data remains on disk in its original worktree and should not be cleaned as part of integration. A successful merge is not evidence of behavioral compatibility.

## Integration result

Main's previously uncommitted source, tests, and documentation were saved in `6e392df`.
The original notes/workbench checkout (`3216`) was saved in `2f74363` on
`integrate/notes-workbench-20260906`, excluding its untracked `work/` app/database backups.
The additional checkpoint work in checkout `0d2f` was not changed or merged.

Thirty conflicting paths were reconciled. The result retains main's session/project deletion,
late-feed suppression, installed-schema compatibility, Claude binary lookup, direct composer,
and collapsed automation history. It adds the workbench's notes, tabs, editors, search,
source-control tools, peer controls, native conversation rewind, and context/agent displays.
The obsolete WorkspacePanel was replaced by ProjectWorkbench. Successful sidebar deletion now
retires its saved workspace tabs and unmounts associated terminals; individual session deletion
preserves independent note and scratch tabs. Two integration tests cover this behavior.

Measured on the merged tree: `cargo test --workspace` passed 592 tests, with 7 ignored;
`npm test` passed 267 tests across 18 files. Ignored live-provider tests were not enabled.
Logs: `/tmp/brigadier-merge-rust-tests.log` and `/tmp/brigadier-merge-frontend-tests.log`.
`npm run tauri build -- --bundles app` passed on the final code and produced
`target/release/bundle/macos/brigadier.app`. Its existing large-chunk/bundle-identifier warnings
remain. The bundle was not installed or launched against owner data. Build log:
`/tmp/brigadier-merge-desktop-build.log`.
The source changes implement the existing workbench delivery; the new redesign decisions
remain an interview record in `docs/plans/chatgpt-redesign-discussion-2026-09-06.md`.
