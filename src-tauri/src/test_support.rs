//! Test-only helpers shared across this crate's unit tests.
//!
//! Nothing here is compiled into the app.

/// Point the workspace lock registry at a per-process throwaway directory, once.
///
/// `brigadier_core`'s `registry_dir()` re-reads `BRIGADIER_WORKSPACE_LOCK_DIR` on **every**
/// acquisition rather than caching it, so any test may set it and the next lease obeys — but
/// whichever module happens to run first decides for the whole binary. Every test-setup helper
/// that can reach a lease therefore calls this, which makes the answer the same regardless of
/// ordering and keeps `~/.brigadier/workspace-locks-v1` untouched by `cargo test`.
///
/// The directory deliberately outlives any `TempDir`: it is re-read per acquisition, so a path
/// that has been unlinked underneath us would send the next lease somewhere unexpected.
/// `crates/core/tests/lock_registry.rs` isolates its own binary the same way.
pub(crate) fn isolate_workspace_locks() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let dir = std::env::temp_dir().join(format!("brigadier-app-locks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("BRIGADIER_WORKSPACE_LOCK_DIR", &dir);
    });
}
