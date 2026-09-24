//! Finding the blob hashes an event payload mentions.
//!
//! A blob is referenced by an event when the event's JSON payload contains its hash: a run of
//! exactly 64 lowercase hex characters, delimited by anything that is not a lowercase hex
//! character. The field it sits in does not matter (`blob`, `id`, a list of artifact refs, a
//! `blob:<hash>` string), so callers never have to declare their references. A false positive
//! (some other 64-hex string, e.g. a SHA-256 digest in a provider event) only keeps a blob
//! longer; it can never cause a referenced blob to be collected.

/// Length of a [`crate::BlobHash`] in hex characters.
const HASH_LEN: usize = 64;

/// Every distinct blob hash `text` mentions, in order of first appearance.
pub(crate) fn blob_hashes(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut found: Vec<&str> = Vec::new();
    if bytes.len() < HASH_LEN {
        return found;
    }
    let mut start = None;
    // One past the end acts as a final delimiter.
    for index in 0..=bytes.len() {
        let hex = bytes
            .get(index)
            .is_some_and(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte));
        match (hex, start) {
            (true, None) => start = Some(index),
            (false, Some(from)) => {
                if index - from == HASH_LEN {
                    // Hex characters are ASCII, so these are char boundaries.
                    let hash = &text[from..index];
                    if !found.contains(&hash) {
                        found.push(hash);
                    }
                }
                start = None;
            }
            _ => {}
        }
    }
    found
}
