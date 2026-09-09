//! brigadier-core: provider SPI, session supervisor, persistence. No Tauri dependency.
//!
//! The SPI is four plain-value pieces: a canonical [`event`] schema every adapter emits, a
//! [`driver`] trait instantiated N times with no singleton, a [`session`] handle a supervisor
//! holds, and an [`approval`] park with a deadline.

#![deny(unsafe_code)]
#![warn(missing_docs)]

pub mod approval;
mod binary;
pub mod checkpoint;
pub mod claude;
pub mod codex;
pub mod driver;
pub mod event;
pub mod session;
pub mod wall;
pub mod worktree;

/// Durable provider-observed account allowance.
pub mod allowance;
