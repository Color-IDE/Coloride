//! The nine Coloride technical contracts and their codecs (`LOT-002`).
//!
//! One submodule per concern; everything is re-exported here so paths such as
//! `host_core::EditorTransaction` do not depend on the split.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

/// Canonical schema version for all Coloride technical contracts (`LOT-002`).
pub const CONTRACT_SCHEMA_VERSION: u16 = 1;

mod approval;
mod bindings;
mod changes;
mod codec;
mod context;
mod editor;
mod evidence;
mod language;
mod models;
mod task;
mod tools;
mod units;
mod validation;

pub use approval::*;
pub use bindings::*;
pub use changes::*;
pub use codec::*;
pub use context::*;
pub use editor::*;
pub use evidence::*;
pub use language::*;
pub use models::*;
pub use task::*;
pub use tools::*;
pub use units::*;
pub use validation::*;

#[cfg(test)]
mod tests;
