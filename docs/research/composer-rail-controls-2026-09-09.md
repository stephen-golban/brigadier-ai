# Composer rail controls — 2026-09-09

Scope: the owner's accepted rail iteration: real workspace/branch selection and the assistant-ui Settings Panel segmented provider selector. Research only; product implementation is owned by the other agents. Labels below distinguish documented API contracts, inspected source, measurements, and implementation inferences.

## Git workspace identity and branch ownership

**Documented:** `git worktree list --porcelain -z` provides a stable machine format including path, HEAD, branch/detached, locked and prunable state. NUL termination preserves embedded newlines in paths. The main worktree is first. `worktree add -b <new> <path> <start>` creates and checks out a new branch; `-b` rejects an existing branch. Without `-b`, an existing branch can be checked out, but Git refuses one already checked out elsewhere. Avoid `--force`, which bypasses that safeguard. `-B` resets an existing branch and is inappropriate for ordinary branch creation. Worktree locks prevent removal/move/pruning; they are not application writer locks. [git-worktree](https://git-scm.com/docs/git-worktree).

**Documented:** `git rev-parse --path-format=absolute --git-common-dir` identifies the shared repository directory; `--show-toplevel` identifies a worktree root. Verify a selected starting ref with `git rev-parse --verify --end-of-options <ref>^{commit}` to obtain an existing commit OID and prevent an option-like input from becoming a flag. [git-rev-parse](https://git-scm.com/docs/git-rev-parse).

**Inference for Brigadier:** repository identity alone does not establish task ownership. Join canonical worktree paths against persisted task/lease records, including idle native execution holders. Revalidate immediately before dispatch under the app's existing lifecycle/writer coordination. Do not infer ownership from a branch prefix or directory name. Unknown/external worktrees must not receive automatic cleanup privileges.

## Branch creation and local/remote starting points

**Documented:** `git for-each-ref` supports `refname`, `objectname`, `symref` and `worktreepath` fields and accepts ref namespace filters. Enumerate `refs/heads/` and `refs/remotes/`; retain full ref IDs and use short names only as labels. `symref` distinguishes a remote's symbolic HEAD alias from a branch. [git-for-each-ref](https://git-scm.com/docs/git-for-each-ref).

**Documented:** `git check-ref-format --branch <name>` validates branch names. This mode can expand previous-checkout syntax, so a UI intending literal new names must reject shorthand rather than silently accept a different branch. [git-check-ref-format](https://git-scm.com/docs/git-check-ref-format).

**Documented:** `git switch -c <new> <start>` creates and switches to a branch transactionally. `--no-guess` avoids remote-name guessing. Normal switching may preserve compatible working edits; overlapping changes cause refusal. `--discard-changes` throws edits away; `--ignore-other-worktrees` bypasses branch exclusivity. Neither belongs in the normal rail operation. [git-switch](https://git-scm.com/docs/git-switch).

**Inference:** resolve the explicitly selected full ref once and pass its OID as the clean starting commit. A remote-tracking ref means the locally observed remote state; do not represent it as a freshly fetched remote tip. Never silently use another remote's same-named branch. Fail visibly if the selected ref disappeared. If creating a branch must include upstream tracking, that is a separate explicit policy from selecting a commit baseline.

## Dirty current snapshot versus clean other branch

**Measured, Apple Git 2.50.1:** a disposable repository contained staged plus unstaged tracked edits and an untracked file. Creating a worktree from `refs/heads/other` produced the committed bytes without the untracked file; source file bytes, status and raw index bytes remained identical. An explicit `refs/remotes/origin/topic` start produced its exact commit. Checking out the already used `main` branch in another worktree failed with exit 128. A NUL porcelain listing preserved a worktree path containing a newline. Ordinary `git switch other` carried compatible dirty bytes and the untracked file. All fixtures were under a temporary directory and removed afterwards; no user repository was modified.

**Inspected source:** `crates/supervisor/src/worktree.rs::prepare_from_source` is already a separate snapshot operation. It verifies shared repository identity, captures the source through `SnapshotStore`, creates a new worktree at captured HEAD, applies captured bytes into that new worktree, imports checkpoint objects, and records a baseline commit/provenance. It does not stage or commit the source worktree. Default `Coverage` excludes ignored files unless explicitly included; scanner limits are 10,000 covered entries, 32 MiB/file, and 512 MiB total. Therefore describe this as a source snapshot, not a byte-for-byte copy of the entire filesystem or preservation of the destination's original staged/unstaged split. [Local implementation](../../crates/supervisor/src/worktree.rs), [coverage and limits](../../crates/core/src/checkpoint/scan.rs).

**Inference:** current-workspace selection should invoke snapshot capture when isolation is requested. Choosing another branch should use its clean commit and must not overlay the current workspace's dirty snapshot. Existing-workspace selection should preserve its own current state and enforce ownership. A branch switch in an existing dirty workspace must not be advertised as a clean start merely because Git accepted it.

## Exact assistant-ui selector source

**Fetched source:** the official page installs `@assistant-ui/elements-settings-panel`; shadcn's namespace registry resolves this to `https://r.assistant-ui.com/{name}.json`. Retrieved [Settings Panel registry JSON](https://r.assistant-ui.com/elements-settings-panel.json) and [surfaces registry JSON](https://r.assistant-ui.com/elements-surfaces.json). Their SHA-256 values were respectively `014c1d9e75bc625083d7017ed9ec3642e29f77a8bfa560a961821e308a67a132` and `4a7cfd4733415f9db617a67e848efddae322e591bb08605606724646a9af3857`. The payload has no package version; these hashes pin the retrieved content. Temporary copies: `/tmp/brigadier-settings-panel-registry.json` and `/tmp/brigadier-settings-surfaces.json`.

**Documented:** standalone SettingsPanel is controlled props/callbacks, with plain buttons using `aria-pressed`. It does not require a runtime or a dedicated primitive. Runtime model-context registration affects later requests, not an active provider turn. [Official Settings Panel page](https://www.assistant-ui.com/elements/settings-panel).

**Exact source extract** from `components/assistant-ui/elements/settings-panel.tsx`:

```tsx
<div className={cn(field, "flex gap-0.5 rounded-full p-0.5")}>
  {models.map((option) => (
    <button
      key={option}
      type="button"
      aria-pressed={option === model}
      onClick={() => onModelChange?.(option)}
      className={cn(
        "flex-1 rounded-full py-1 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.97]",
        option === model
          ? "bg-background text-foreground/90"
          : "text-foreground/45 hover:text-foreground/70",
      )}
    >
      {option}
    </button>
  ))}
</div>
```

**Exact surface token:** `field = "bg-foreground/[0.04] dark:bg-foreground/[0.06]"`. Extracting this selector needs React and local styling only. The complete panel also uses `cn`, surfaces, and a range helper; it does not justify adding those unrelated controls to Brigadier. Keep stable provider IDs separate from visible labels. Parent and editor agent received the source/style details before implementation.

**License inspected:** upstream [MIT license](https://github.com/assistant-ui/assistant-ui/blob/main/LICENSE), copyright 2025 AgentbaseAI Inc., matches `licenses/assistant-ui-MIT.txt`. Added specific selector/surface attribution to `THIRD_PARTY_NOTICES.md`.

## Review status and limits

No new provider calls or native UI checks were performed in this research iteration. The temporary Git experiments verify core command behavior, not the app's new IPC or task ownership implementation. Backend workspace review will follow its implementation; findings must be added here before claiming that behavior is verified.

## Authorized delivery: merge, cleanup, installed app

**Documented:** `git merge --no-commit` pauses before a merge commit but does not pause a fast-forward. Use `--no-ff --no-commit` when inspection before any branch advance is required. Resolve conflicts and verify the combined tree before committing. Then `git merge --ff-only <verified-commit>` in main refuses divergence instead of creating an unverified merge. Begin with committed work because `merge --abort` cannot always reconstruct preexisting uncommitted edits. [git-merge](https://git-scm.com/docs/git-merge).

**Documented:** `worktree unlock` releases the Git lock; ordinary removal requires a clean checkout. Force overrides dirt; overriding a remaining lock requires force twice. [git-worktree](https://git-scm.com/docs/git-worktree). `git branch -d` requires the branch merged into its upstream, or HEAD when no upstream exists; `-D` bypasses that check. Verify ancestry to main separately, remove the owned worktree from another directory, then delete its integrated branch. [git-branch](https://git-scm.com/docs/git-branch). The earlier ignored-file deletion warning still applies; only authorized session worktrees are cleanup targets.

**Vendor manual inspected:** `/usr/share/man/man1/ditto.1` and `/usr/bin/ditto -h`. `ditto source.app destination.app` merges into an existing destination directory, retaining destination-only files. Therefore complete replacement needs a fresh destination: finish the release build, quit the installed app, remove the exact authorized `/Applications/Brigadier.app` bundle, and copy the built bundle there with `ditto`. Do not use `--keepBinaries`, `--keepBinariesPattern`, or inherited `DITTOKEEPBINARIESPATTERN`/`DITTOKEEPBINARIESDIR` for this no-backup request. Defaults preserve resource forks, extended attributes and ACLs. Copy success is exit zero; it does not establish launch success. Inspect and launch the installed bundle afterwards. The research agent performed no merge, cleanup or app mutation.
