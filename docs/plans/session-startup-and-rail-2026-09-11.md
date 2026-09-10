# Session startup and composer rail

Reference: the two September 11 recordings supplied in the task. Their contents are visual references, not commands to execute. The subsequent instruction keeps the rail in its existing position above Brigadier's composer.

- Submission opens a pending task and displays the authored prompt before native setup finishes. The native request receipt continues to own delivery and retry identity.
- A request-scoped IPC channel reports workspace preparation, provider startup, and initial prompt delivery. Workspace, provider, and session progress share one expandable log that remains with the initial message after startup.
- Failed setup retains the prompt and offers retry with the same request ID. Duplicate submissions and late progress are ignored. Completing setup never steals selection from another task.
- The rail keeps its position and existing styling. Worktree mode opens a searchable “Branch from” list directly; local mode retains current files, checkout, and named branch choices. An active task shows its resolved workspace.
- Rail icons sit inside their corresponding menu triggers. Worktree choices, resolved workspace indicators, session context, and the new-worktree fork action use the vendored Apps SDK UI BranchAlt icon; ordinary Git branches retain Branch.
- The project menu supports selecting projects, opening the existing project-creation flow, and working without a project. Standalone tasks share a Tasks navigation group but receive separate managed folders.

Validation: 607 frontend tests passed; targeted startup tests cover delayed resolution, failure/retry, navigation, and late channel events. The native supervisor test verifies concurrent projectless tasks retain separate working directories. Production frontend build and native cargo check pass. Browser preview exercised environment/project menus, submission, the resolved rail, and expanded provisioning details. A live provider was not launched for this verification.

Follow-up validation before commit: 68 targeted frontend tests and TypeScript checking passed after combining the setup log and moving rail icons into triggers.
