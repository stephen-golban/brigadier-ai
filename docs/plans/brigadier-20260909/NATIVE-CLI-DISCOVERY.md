# Native CLI discovery correction

Normal LaunchServices startup omitted `~/.local/bin` from the app PATH, so Codex failed registration and Resume reported `no driver registered for codex`. The installed CLI is a symlink from `/Users/stephen/.local/bin/codex` to the standalone package under `~/.codex/packages/standalone/current/bin/codex`.

Codex now uses the shared resolver extracted from Claude's existing discovery conventions. Search order is explicit configured binary, ordered nonempty PATH entries, `~/.local/bin`, then `/opt/homebrew/bin` and `/usr/local/bin` on macOS. Explicit configuration remains authoritative even if invalid. Automatic discovery checks executable files, follows valid symlinks, and skips broken links/directories/non-executable files. No shell is invoked and no process or global environment is changed.

Startup already logs the actual Codex probe error; missing providers are excluded from the provider catalog. UI registration error reporting was inspected and left outside this bounded correction.

Validation:

- `cargo test -p brigadier-core --lib binary`: 9 passed, including 6 shared resolver tests.
- `cargo test -p brigadier-core --test codex_adapter`: 17 passed, 2 opt-in live tests ignored.
- `git diff --check`: passed.

Code ownership released for source task rebuild/reinstall. Native normal-launch acceptance remains pending that rebuild.
