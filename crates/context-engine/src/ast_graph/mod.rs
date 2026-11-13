//! Incremental AST parsing and dependency-graph impact analysis over `ropey` buffers (`LOT-007`).
//!
//! Submodules pull the shared imports below in with `use super::*`.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use host_core::{
    utf16_span_to_utf8, ConfidenceLevel, EditorTransaction, OffsetConversionError, Utf8ByteOffset,
    Utf8Span,
};
use ropey::Rope;
use serde::{Deserialize, Serialize};
use thiserror::Error;

mod impact;
mod line_classifier;
mod position;
mod syntax_tree;

pub use impact::*;
pub use position::*;
pub use syntax_tree::*;

use line_classifier::*;
