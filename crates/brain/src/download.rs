//! Downloading the embedding model's files from its Hugging Face repository at the pinned
//! revision, each checked against its size and SHA-256. A download resumes what an earlier
//! one left in `<file>.part`.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::embed;

pub(crate) const CONFIG: &str = "config.json";
pub(crate) const TOKENIZER: &str = "tokenizer.json";
pub(crate) const MODEL: &str = "model.safetensors";

struct ModelFile {
    name: &'static str,
    bytes: u64,
    sha256: &'static str,
}

/// The files the embedder needs, smallest first.
const FILES: [ModelFile; 3] = [
    ModelFile {
        name: CONFIG,
        bytes: 202,
        sha256: "63c00d90824c832c04ec1d02b6a983fb90489bf049f29fbff15ba481b8a432ee",
    },
    ModelFile {
        name: TOKENIZER,
        bytes: 1_493_150,
        sha256: "7d75cbc54318138807c401b0f0c9721117c628b39de8e8e0edb6cb17e0ee7d18",
    },
    ModelFile {
        name: MODEL,
        bytes: 129_210_456,
        sha256: "07609e5bd33aad37900b3fd62f4ec96f6daec88ca4d46b9d8b928bfababf6ea0",
    },
];

/// Progress is reported at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

pub(crate) fn total_bytes() -> u64 {
    FILES.iter().map(|file| file.bytes).sum()
}

/// Every file was checked when its download ended; after that, the right size is taken as it.
pub(crate) fn installed(dir: &Path) -> bool {
    FILES.iter().all(|file| {
        std::fs::metadata(dir.join(file.name)).is_ok_and(|meta| meta.len() == file.bytes)
    })
}

/// Removes the installed files (not partial downloads), so the next download fetches them.
pub(crate) fn remove(dir: &Path) {
    for file in &FILES {
        let _ = std::fs::remove_file(dir.join(file.name));
    }
}

/// Downloads whatever is missing into `dir`, calling `progress` with the bytes received of
/// [`total_bytes`]. A stop through `cancel` keeps the partial file for the next try.
pub(crate) fn fetch(
    dir: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|err| format!("couldn't make {}: {err}", dir.display()))?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .build()
        .into();
    let mut done = 0;
    for file in &FILES {
        let dest = dir.join(file.name);
        if !std::fs::metadata(&dest).is_ok_and(|meta| meta.len() == file.bytes) {
            fetch_file(&agent, file, &dest, cancel, &mut |received| {
                progress(done + received);
            })?;
        }
        done += file.bytes;
        progress(done);
    }
    Ok(())
}

fn fetch_file(
    agent: &ureq::Agent,
    file: &ModelFile,
    dest: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<(), String> {
    let part = dest.with_file_name(format!("{}.part", file.name));
    let mut hasher = Sha256::new();
    let mut have = match std::fs::File::open(&part) {
        Ok(mut kept) => hash_into(&mut kept, &mut hasher).map_err(|err| err.to_string())?,
        Err(_) => 0,
    };
    if have >= file.bytes {
        // Complete or overlong leftovers: start over.
        have = 0;
        hasher = Sha256::new();
    }

    let url = format!(
        "https://huggingface.co/{}/resolve/{}/{}",
        embed::REPO,
        embed::REVISION,
        file.name
    );
    let mut request = agent.get(&url);
    if have > 0 {
        request = request.header("Range", format!("bytes={have}-"));
    }
    let response = request
        .call()
        .map_err(|err| format!("couldn't reach the model's server: {err}"))?;
    // Appending needs the server to continue exactly where the partial file ends.
    let resumed = have > 0
        && response.status().as_u16() == 206
        && response
            .headers()
            .get("content-range")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|range| range.starts_with(&format!("bytes {have}-")));
    let mut out = if resumed {
        std::fs::OpenOptions::new()
            .append(true)
            .open(&part)
            .map_err(|err| err.to_string())?
    } else {
        have = 0;
        hasher = Sha256::new();
        std::fs::File::create(&part).map_err(|err| err.to_string())?
    };

    let mut body = response.into_body().into_reader();
    let mut buf = vec![0u8; 1 << 16];
    let mut received = have;
    let mut reported = Instant::now();
    progress(received);
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = out.sync_all();
            return Err("cancelled".into());
        }
        let n = body
            .read(&mut buf)
            .map_err(|err| format!("the download broke off: {err}"))?;
        if n == 0 {
            break;
        }
        received += n as u64;
        if received > file.bytes {
            drop(out);
            let _ = std::fs::remove_file(&part);
            return Err("the model's server sent more than expected".into());
        }
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n])
            .map_err(|err| format!("couldn't save the model: {err}"))?;
        if reported.elapsed() >= PROGRESS_EVERY {
            reported = Instant::now();
            progress(received);
        }
    }
    out.sync_all().map_err(|err| err.to_string())?;
    drop(out);

    let digest: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if received != file.bytes || digest != file.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(format!("{} didn't match its checksum", file.name));
    }
    std::fs::rename(&part, dest).map_err(|err| format!("couldn't keep the model: {err}"))?;
    Ok(())
}

/// Feeds a file to `hasher`; returns its length.
fn hash_into(file: &mut std::fs::File, hasher: &mut Sha256) -> std::io::Result<u64> {
    let mut buf = vec![0u8; 1 << 16];
    let mut total = 0;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            return Ok(total);
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
}
