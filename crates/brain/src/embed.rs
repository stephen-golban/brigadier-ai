//! The local embedding model: minishlab/potion-retrieval-32M, Model2Vec static embeddings
//! (MIT). A text's embedding is the mean of its tokens' rows in one matrix, normalized, so
//! inference is a tokenizer plus a lookup and needs no ML runtime.
//!
//! The f32 matrix (129 MB on disk) is read row by row and kept as int8 with one scale per row,
//! about 32 MB in one anonymous mapping. Unloading unmaps it, so the memory goes back to the
//! system at once; freed heap blocks of that size would stay resident in the allocator's cache.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use memmap2::MmapMut;
use safetensors::Dtype;
use safetensors::tensor::Metadata;
use tokenizers::Tokenizer;
use tokenizers::models::ModelWrapper;

use crate::db::lock;
use crate::vectors::{self, Vectors};
use crate::{EmbedderState, EmbedderStatus, Error, Result, download};

macro_rules! repo {
    () => {
        "minishlab/potion-retrieval-32M"
    };
}
macro_rules! revision {
    () => {
        "6fc8051fab2a1e0ee76689cf08c853792ac285e7"
    };
}

pub(crate) const REPO: &str = repo!();
pub(crate) const REVISION: &str = revision!();
/// Which model made a stored embedding; nodes embedded by another are embedded again.
pub(crate) const MODEL_ID: &str = concat!(repo!(), "@", revision!());
/// The folder under the models directory.
pub(crate) const FOLDER: &str = "potion-retrieval-32M";
pub(crate) const DIMENSIONS: usize = 512;
/// Tokens past this are ignored, as in Model2Vec.
const MAX_TOKENS: usize = 512;
/// A load that failed is not tried again sooner than this.
const RETRY_AFTER: Duration = Duration::from_secs(60);

/// The embedder behind [`crate::Embedder`].
pub(crate) struct Inner {
    dir: PathBuf,
    slot: Mutex<Slot>,
    /// Every Brain's vector cache, dropped with the model: queries cannot use it without one.
    caches: Mutex<Vec<Weak<Vectors>>>,
}

struct Slot {
    model: Option<Arc<Model>>,
    loading: bool,
    /// Bytes received and expected while a download runs.
    download: Option<(u64, u64)>,
    failed: Option<(String, Instant)>,
    last_used: Instant,
}

impl Inner {
    pub(crate) fn new(models_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            dir: models_dir.join(FOLDER),
            slot: Mutex::new(Slot {
                model: None,
                loading: false,
                download: None,
                failed: None,
                last_used: Instant::now(),
            }),
            caches: Mutex::new(Vec::new()),
        })
    }

    pub(crate) fn status(&self) -> EmbedderStatus {
        let state = {
            let slot = lock(&self.slot);
            if let Some((received, total)) = slot.download {
                Some(EmbedderState::Downloading { received, total })
            } else if slot.loading {
                Some(EmbedderState::Loading)
            } else if slot.model.is_some() {
                Some(EmbedderState::Loaded)
            } else {
                slot.failed
                    .as_ref()
                    .map(|(error, _)| EmbedderState::Failed {
                        error: error.clone(),
                    })
            }
        };
        // Looked at without the lock, which embedding takes on every call.
        let state = state.unwrap_or_else(|| {
            if download::installed(&self.dir) {
                EmbedderState::Installed
            } else {
                EmbedderState::NotInstalled
            }
        });
        EmbedderStatus {
            model: MODEL_ID.to_owned(),
            model_bytes: download::total_bytes(),
            dimensions: DIMENSIONS as u32,
            state,
        }
    }

    pub(crate) fn download(&self, cancel: &std::sync::atomic::AtomicBool) -> Result<()> {
        let total = download::total_bytes();
        {
            let mut slot = lock(&self.slot);
            if slot.download.is_some() {
                return Err(Error::Download("a download is already running".into()));
            }
            slot.download = Some((0, total));
        }
        let result = download::fetch(&self.dir, cancel, |received| {
            lock(&self.slot).download = Some((received, total));
        });
        let mut slot = lock(&self.slot);
        slot.download = None;
        if result.is_ok() {
            slot.failed = None;
        }
        result.map_err(Error::Download)
    }

    pub(crate) fn request_load(self: &Arc<Self>) {
        {
            let mut slot = lock(&self.slot);
            if slot.model.is_some() || slot.loading || slot.download.is_some() {
                return;
            }
            if slot
                .failed
                .as_ref()
                .is_some_and(|(_, at)| at.elapsed() < RETRY_AFTER)
            {
                return;
            }
            if !download::installed(&self.dir) {
                return;
            }
            slot.loading = true;
        }
        let this = self.clone();
        let spawned = std::thread::Builder::new()
            .name("brain-embedder".into())
            .spawn(move || this.load());
        if let Err(err) = spawned {
            let mut slot = lock(&self.slot);
            slot.loading = false;
            slot.failed = Some((format!("couldn't start loading: {err}"), Instant::now()));
        }
    }

    fn load(&self) {
        let started = Instant::now();
        let result = Model::load(&self.dir);
        let mut slot = lock(&self.slot);
        slot.loading = false;
        match result {
            Ok(model) => {
                tracing::info!(
                    took_ms = started.elapsed().as_millis() as u64,
                    rows = model.scales.len(),
                    "embedding model loaded"
                );
                slot.model = Some(Arc::new(model));
                slot.failed = None;
                slot.last_used = Instant::now();
            }
            Err(err) => {
                let message = match err {
                    LoadError::Io(message) => message,
                    LoadError::Corrupt(message) => {
                        // Downloading again is the fix; the files are ours to remove.
                        download::remove(&self.dir);
                        format!("{message} (the model will be downloaded again)")
                    }
                };
                tracing::warn!(%message, "embedding model failed to load");
                slot.failed = Some((message, Instant::now()));
            }
        }
    }

    /// The model, if loaded, marked as used now.
    fn model(&self) -> Option<Arc<Model>> {
        let mut slot = lock(&self.slot);
        let model = slot.model.clone()?;
        slot.last_used = Instant::now();
        Some(model)
    }

    pub(crate) fn embed(&self, texts: &[&str]) -> Option<Vec<Vec<f32>>> {
        let model = self.model()?;
        Some(texts.iter().map(|text| model.embed(text)).collect())
    }

    pub(crate) fn loaded(&self) -> bool {
        lock(&self.slot).model.is_some()
    }

    pub(crate) fn unload_if_idle(&self, idle: Duration) {
        let model = {
            let mut slot = lock(&self.slot);
            if slot.model.is_none() || slot.last_used.elapsed() < idle {
                return;
            }
            slot.model.take()
        };
        // An embedding in progress keeps its reference; the matrix goes when it finishes.
        drop(model);
        let mut caches = lock(&self.caches);
        caches.retain(|cache| match cache.upgrade() {
            Some(cache) => {
                cache.clear();
                true
            }
            None => false,
        });
        tracing::info!("embedding model unloaded");
    }

    pub(crate) fn register(&self, cache: &Arc<Vectors>) {
        let mut caches = lock(&self.caches);
        caches.retain(|cache| cache.strong_count() > 0);
        caches.push(Arc::downgrade(cache));
    }
}

enum LoadError {
    /// Reading failed; the files may be fine.
    Io(String),
    /// The files are not the model they should be.
    Corrupt(String),
}

impl From<std::io::Error> for LoadError {
    fn from(err: std::io::Error) -> Self {
        if err.kind() == std::io::ErrorKind::UnexpectedEof {
            LoadError::Corrupt("the model file is truncated".into())
        } else {
            LoadError::Io(format!("reading the model: {err}"))
        }
    }
}

struct Model {
    tokenizer: Tokenizer,
    /// Dropped from every text, as Model2Vec does.
    unknown: Option<u32>,
    /// Texts are cut to this many characters before tokenizing: [`MAX_TOKENS`] times the
    /// median token length, as Model2Vec does, so a huge text costs no more than a long one.
    max_chars: usize,
    /// One per row of `values`.
    scales: Vec<f32>,
    /// `[vocabulary, DIMENSIONS]` int8 values (stored as their bytes), row-major.
    values: MmapMut,
}

impl Model {
    fn load(dir: &Path) -> std::result::Result<Self, LoadError> {
        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join(download::CONFIG))?)
                .map_err(|err| LoadError::Corrupt(format!("the model config: {err}")))?;
        if config["hidden_dim"].as_u64() != Some(DIMENSIONS as u64)
            || config["normalize"].as_bool() != Some(true)
        {
            return Err(LoadError::Corrupt(
                "the model config is not the expected one".into(),
            ));
        }

        let tokenizer = Tokenizer::from_bytes(std::fs::read(dir.join(download::TOKENIZER))?)
            .map_err(|err| LoadError::Corrupt(format!("the tokenizer: {err}")))?;
        let unknown = match tokenizer.get_model() {
            ModelWrapper::WordPiece(model) => Some(model.unk_token.clone()),
            ModelWrapper::BPE(model) => model.unk_token.clone(),
            ModelWrapper::WordLevel(model) => Some(model.unk_token.clone()),
            ModelWrapper::Unigram(_) => None,
        }
        .and_then(|token| tokenizer.token_to_id(&token));
        // Token by token: a copy of the whole vocabulary would stay resident after it is freed.
        let vocabulary = u32::try_from(tokenizer.get_vocab_size(true)).unwrap_or(u32::MAX);
        let mut lengths: Vec<usize> = (0..vocabulary)
            .filter_map(|id| tokenizer.id_to_token(id))
            .map(|token| token.chars().count())
            .collect();
        lengths.sort_unstable();
        let median = match lengths.len() {
            0 => 1,
            n if n % 2 == 1 => lengths[n / 2],
            n => (lengths[n / 2 - 1] + lengths[n / 2]) / 2,
        };

        let (scales, values) = read_matrix(&dir.join(download::MODEL))?;
        Ok(Self {
            tokenizer,
            unknown,
            max_chars: MAX_TOKENS * median.max(1),
            scales,
            values,
        })
    }

    /// The normalized mean of the text's token rows (all zeros when it has no known token).
    fn embed(&self, text: &str) -> Vec<f32> {
        let text = match text.char_indices().nth(self.max_chars) {
            Some((end, _)) => &text[..end],
            None => text,
        };
        let mut sum = vec![0f32; DIMENSIONS];
        let ids = match self.tokenizer.encode_fast(text, false) {
            Ok(encoding) => encoding.get_ids().to_vec(),
            Err(err) => {
                tracing::warn!(error = %err, "tokenizing for an embedding failed");
                return sum;
            }
        };
        let tokens = ids
            .into_iter()
            .filter(|id| Some(*id) != self.unknown)
            .take(MAX_TOKENS)
            .filter_map(|id| usize::try_from(id).ok())
            .filter(|row| *row < self.scales.len());
        for row in tokens {
            let scale = self.scales[row];
            let values = &self.values[row * DIMENSIONS..(row + 1) * DIMENSIONS];
            for (total, value) in sum.iter_mut().zip(values) {
                *total += f32::from(i8::from_le_bytes([*value])) * scale;
            }
        }
        // The mean's direction is the sum's, so normalizing the sum gives the same vector.
        let norm = sum.iter().map(|value| value * value).sum::<f32>().sqrt();
        if norm > 0.0 {
            for value in &mut sum {
                *value /= norm;
            }
        }
        sum
    }
}

/// Reads the `embeddings` tensor (f32 `[vocabulary, DIMENSIONS]`) a row at a time, quantizing
/// each as it goes, so the f32 matrix is never in memory.
fn read_matrix(path: &Path) -> std::result::Result<(Vec<f32>, MmapMut), LoadError> {
    let corrupt = |message: &str| LoadError::Corrupt(format!("the model file: {message}"));
    let file = File::open(path)?;
    let file_len = file.metadata()?.len();
    let mut reader = BufReader::with_capacity(1 << 16, file);
    let mut len = [0u8; 8];
    reader.read_exact(&mut len)?;
    let header_len = u64::from_le_bytes(len);
    if header_len > 1 << 20 {
        return Err(corrupt("its header is too large"));
    }
    let mut header = vec![0u8; header_len as usize];
    reader.read_exact(&mut header)?;
    let metadata: Metadata =
        serde_json::from_slice(&header).map_err(|err| corrupt(&err.to_string()))?;
    if 8 + header_len + metadata.data_len() as u64 != file_len {
        return Err(corrupt("its size doesn't match its header"));
    }
    let info = metadata
        .info("embeddings")
        .ok_or_else(|| corrupt("it has no embeddings"))?;
    let rows = match info.shape.as_slice() {
        [rows, dims] if *dims == DIMENSIONS && info.dtype == Dtype::F32 => *rows,
        _ => return Err(corrupt("its embeddings have an unexpected shape")),
    };
    let (start, end) = info.data_offsets;
    if end - start != rows * DIMENSIONS * 4 {
        return Err(corrupt("its embeddings have an unexpected size"));
    }
    reader.seek_relative(start as i64)?;

    let mut scales = Vec::with_capacity(rows);
    let mut values = MmapMut::map_anon(rows * DIMENSIONS)
        .map_err(|err| LoadError::Io(format!("allocating the model: {err}")))?;
    let mut raw = vec![0u8; DIMENSIONS * 4];
    let mut row = vec![0f32; DIMENSIONS];
    let mut quantized = [0i8; DIMENSIONS];
    for out in values.as_chunks_mut::<DIMENSIONS>().0 {
        reader.read_exact(&mut raw)?;
        for (value, bytes) in row.iter_mut().zip(raw.as_chunks::<4>().0) {
            *value = f32::from_le_bytes(*bytes);
        }
        scales.push(vectors::quantize(&row, &mut quantized));
        for (byte, value) in out.iter_mut().zip(quantized) {
            *byte = value.to_le_bytes()[0];
        }
    }
    Ok((scales, values))
}
