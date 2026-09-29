//! Moving a file or folder to the system's Trash (the Recycle Bin on Windows).

use std::path::Path;

/// Moves `path` to the Trash. On macOS through `NSFileManager`, which needs no permission to
/// script the Finder and makes no sound.
pub(crate) fn to_trash(path: &Path) -> Result<(), String> {
    #[allow(unused_mut)]
    let mut context = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos as _};
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context.delete(path).map_err(|err| err.to_string())
}
