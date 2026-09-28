//! Node embeddings: int8 with one f32 scale per vector, stored in `nodes.embedding` and kept in
//! memory per Brain for brute-force cosine search (10k × 512 bytes is a few milliseconds; no
//! vector extension).

use std::collections::HashMap;
use std::sync::RwLock;

use rusqlite::Connection;

use crate::{NodeKind, Result, db, embed};

/// A stored vector: the f32 scale (little endian), then one i8 per dimension.
const BLOB_BYTES: usize = 4 + embed::DIMENSIONS;

/// Quantizes a vector to int8 with one scale: `value ≈ q * scale`.
pub(crate) fn quantize(vector: &[f32], out: &mut [i8]) -> f32 {
    let max = vector.iter().fold(0f32, |max, value| max.max(value.abs()));
    if max == 0.0 {
        out.fill(0);
        return 0.0;
    }
    let scale = max / 127.0;
    for (slot, value) in out.iter_mut().zip(vector) {
        // In range by construction; the cast saturates anyway.
        *slot = (value / scale).round() as i8;
    }
    scale
}

/// The stored form of a normalized embedding.
pub(crate) fn encode(vector: &[f32]) -> Vec<u8> {
    let mut values = [0i8; embed::DIMENSIONS];
    let scale = quantize(vector, &mut values);
    let mut blob = Vec::with_capacity(BLOB_BYTES);
    blob.extend_from_slice(&scale.to_le_bytes());
    blob.extend(values.iter().map(|value| value.to_le_bytes()[0]));
    blob
}

fn decode(blob: &[u8]) -> Option<(f32, impl Iterator<Item = i8> + '_)> {
    if blob.len() != BLOB_BYTES {
        return None;
    }
    let scale = f32::from_le_bytes(blob[..4].try_into().ok()?);
    Some((
        scale,
        blob[4..].iter().map(|byte| i8::from_le_bytes([*byte])),
    ))
}

/// A change to the vectors, applied after the write that made it commits.
#[derive(Debug)]
pub(crate) enum Change {
    /// A node's current embedding (a stored blob).
    Set {
        id: String,
        kind: NodeKind,
        superseded: bool,
        blob: Vec<u8>,
    },
    /// The node is gone, or its text changed and it has no embedding yet.
    Remove(String),
    Superseded {
        id: String,
        superseded: bool,
    },
}

/// One Brain's vectors in memory: rows side by side in one allocation, so dropping the table
/// returns it whole.
#[derive(Default)]
struct Table {
    ids: Vec<String>,
    kinds: Vec<NodeKind>,
    superseded: Vec<bool>,
    scales: Vec<f32>,
    values: Vec<i8>,
    rows: HashMap<String, usize>,
}

impl Table {
    fn set(&mut self, id: &str, kind: NodeKind, superseded: bool, blob: &[u8]) {
        let Some((scale, values)) = decode(blob) else {
            self.remove(id);
            return;
        };
        match self.rows.get(id) {
            Some(&row) => {
                self.kinds[row] = kind;
                self.superseded[row] = superseded;
                self.scales[row] = scale;
                let dims = embed::DIMENSIONS;
                for (slot, value) in self.values[row * dims..(row + 1) * dims]
                    .iter_mut()
                    .zip(values)
                {
                    *slot = value;
                }
            }
            None => {
                self.rows.insert(id.to_owned(), self.ids.len());
                self.ids.push(id.to_owned());
                self.kinds.push(kind);
                self.superseded.push(superseded);
                self.scales.push(scale);
                self.values.extend(values);
            }
        }
    }

    fn remove(&mut self, id: &str) {
        let Some(row) = self.rows.remove(id) else {
            return;
        };
        let last = self.ids.len() - 1;
        if row != last {
            let dims = embed::DIMENSIONS;
            self.values
                .copy_within(last * dims..(last + 1) * dims, row * dims);
            self.rows.insert(self.ids[last].clone(), row);
        }
        self.ids.swap_remove(row);
        self.kinds.swap_remove(row);
        self.superseded.swap_remove(row);
        self.scales.swap_remove(row);
        self.values.truncate(last * embed::DIMENSIONS);
    }

    fn apply(&mut self, change: &Change) {
        match change {
            Change::Set {
                id,
                kind,
                superseded,
                blob,
            } => self.set(id, *kind, *superseded, blob),
            Change::Remove(id) => self.remove(id),
            Change::Superseded { id, superseded } => {
                if let Some(&row) = self.rows.get(id) {
                    self.superseded[row] = *superseded;
                }
            }
        }
    }
}

/// A Brain's vector cache: built from the database on the first semantic query, kept current
/// by the writer, and dropped when the embedding model unloads.
#[derive(Default)]
pub(crate) struct Vectors {
    table: RwLock<Option<Table>>,
}

impl Vectors {
    /// Applies committed changes; nothing to do while the cache is not built (it will read
    /// them from the database).
    pub(crate) fn apply(&self, changes: &[Change]) {
        if changes.is_empty() {
            return;
        }
        let mut table = self.table.write().unwrap_or_else(|err| err.into_inner());
        if let Some(table) = table.as_mut() {
            for change in changes {
                table.apply(change);
            }
        }
    }

    pub(crate) fn clear(&self) {
        let table = self
            .table
            .write()
            .unwrap_or_else(|err| err.into_inner())
            .take();
        drop(table);
    }

    /// Builds the cache from `conn` if it is not built. It holds the lock while it reads, so a
    /// write committing meanwhile applies its change after the build, never before it.
    fn ensure(&self, conn: &Connection) -> Result<()> {
        if self
            .table
            .read()
            .unwrap_or_else(|err| err.into_inner())
            .is_some()
        {
            return Ok(());
        }
        let mut slot = self.table.write().unwrap_or_else(|err| err.into_inner());
        if slot.is_some() {
            return Ok(());
        }
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM nodes WHERE embedding IS NOT NULL AND embed_model = ?1",
            [embed::MODEL_ID],
            |row| row.get(0),
        )?;
        let count = usize::try_from(count).unwrap_or(0);
        let mut table = Table {
            ids: Vec::with_capacity(count),
            kinds: Vec::with_capacity(count),
            superseded: Vec::with_capacity(count),
            scales: Vec::with_capacity(count),
            values: Vec::with_capacity(count * embed::DIMENSIONS),
            rows: HashMap::with_capacity(count),
        };
        let mut statement = conn.prepare_cached(
            "SELECT id, kind, state = 'superseded', embedding FROM nodes \
             WHERE embedding IS NOT NULL AND embed_model = ?1",
        )?;
        let mut rows = statement.query([embed::MODEL_ID])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let kind: String = row.get(1)?;
            let Some(kind) = db::parse_kind(&kind) else {
                continue;
            };
            let blob = row.get_ref(3)?.as_blob().map_err(rusqlite::Error::from)?;
            table.set(&id, kind, row.get(2)?, blob);
        }
        *slot = Some(table);
        Ok(())
    }

    /// The `k` nodes most similar to `query` (a normalized vector) that `keep` accepts, best
    /// first, with their cosine similarity.
    pub(crate) fn nearest(
        &self,
        conn: &Connection,
        query: &[f32],
        k: usize,
        keep: impl Fn(NodeKind, bool) -> bool,
    ) -> Result<Vec<(String, f32)>> {
        self.ensure(conn)?;
        let table = self.table.read().unwrap_or_else(|err| err.into_inner());
        let Some(table) = table.as_ref() else {
            return Ok(Vec::new());
        };
        let dims = embed::DIMENSIONS;
        let mut scored: Vec<(f32, usize)> = Vec::with_capacity(table.ids.len());
        for (row, values) in table.values.chunks_exact(dims).enumerate() {
            if !keep(table.kinds[row], table.superseded[row]) {
                continue;
            }
            let dot: f32 = values
                .iter()
                .zip(query)
                .map(|(value, q)| f32::from(*value) * q)
                .sum();
            scored.push((dot * table.scales[row], row));
        }
        let by_score = |a: &(f32, usize), b: &(f32, usize)| b.0.total_cmp(&a.0);
        if scored.len() > k {
            scored.select_nth_unstable_by(k, by_score);
            scored.truncate(k);
        }
        scored.sort_unstable_by(by_score);
        Ok(scored
            .into_iter()
            .filter(|(score, _)| *score > 0.0)
            .map(|(score, row)| (table.ids[row].clone(), score))
            .collect())
    }
}
