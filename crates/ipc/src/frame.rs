//! Length-prefixed JSON frames: a big-endian `u32` byte length, then that many bytes of JSON.

use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, BufWriter};

use crate::{Error, MAX_FRAME_BYTES};

pub struct FrameReader<R> {
    inner: BufReader<R>,
    buffer: Vec<u8>,
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner: BufReader::new(inner),
            buffer: Vec::new(),
        }
    }

    /// The next frame, or `None` when the peer closed the connection between frames.
    pub async fn read<T: DeserializeOwned>(&mut self) -> Result<Option<T>, Error> {
        let mut len = [0u8; 4];
        match self.inner.read_exact(&mut len).await {
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(err) => return Err(err.into()),
        }
        let len = u32::from_be_bytes(len) as usize;
        // Checked before allocating, so a hostile length cannot exhaust memory.
        if len > MAX_FRAME_BYTES {
            return Err(Error::FrameTooLarge(len));
        }
        self.buffer.resize(len, 0);
        self.inner.read_exact(&mut self.buffer).await?;
        let frame = serde_json::from_slice(&self.buffer)?;
        // Don't keep a huge buffer alive after an occasional large frame.
        if self.buffer.capacity() > 64 * 1024 {
            self.buffer = Vec::new();
        }
        Ok(Some(frame))
    }
}

pub struct FrameWriter<W: AsyncWrite> {
    inner: BufWriter<W>,
}

impl<W: AsyncWrite + Unpin> FrameWriter<W> {
    pub fn new(inner: W) -> Self {
        Self {
            inner: BufWriter::new(inner),
        }
    }

    /// Writes and flushes one frame.
    pub async fn write<T: Serialize>(&mut self, frame: &T) -> Result<(), Error> {
        self.write_buffered(frame).await?;
        self.flush().await
    }

    /// Writes one frame without flushing, for sending several frames in a row.
    pub async fn write_buffered<T: Serialize>(&mut self, frame: &T) -> Result<(), Error> {
        let bytes = serde_json::to_vec(frame)?;
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(Error::FrameTooLarge(bytes.len()));
        }
        self.inner
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .await?;
        self.inner.write_all(&bytes).await?;
        Ok(())
    }

    pub async fn flush(&mut self) -> Result<(), Error> {
        self.inner.flush().await?;
        Ok(())
    }
}
