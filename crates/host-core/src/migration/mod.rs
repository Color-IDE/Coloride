//! 1-click onboarding and migration from VS Code, Cursor and Claude Desktop (`LOT-006`).
//!
//! Everything imported is read-only data: nothing is executed. One submodule per concern,
//! re-exported here so public paths do not depend on the split.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Redaction mask applied to sensitive environment variables in imported MCP configs.
pub const REDACTED_ENV_VALUE: &str = "•••••••• [REDACTED]";

/// Default Coloride theme name used on clean install or 1-click reset.
pub const DEFAULT_COLORIDE_THEME: &str = "Coloride Dark (WCAG AAA)";
/// Default Coloride icon theme name.
pub const DEFAULT_COLORIDE_ICON_THEME: &str = "Coloride Geometric Icons";
/// Default Coloride monospace font family.
pub const DEFAULT_COLORIDE_FONT_FAMILY: &str = "JetBrains Mono, SF Mono, Cascadia Code, monospace";
/// Default Coloride editor font size in pixels.
pub const DEFAULT_COLORIDE_FONT_SIZE: u16 = 14;
/// Default Coloride editor tab size.
pub const DEFAULT_COLORIDE_TAB_SIZE: u8 = 2;

#[derive(Debug, Error)]
pub enum MigrationError {
    #[error("JSONC syntax error: {0}")]
    JsoncSyntax(String),
    #[error("Invalid VSIX archive: {0}")]
    InvalidVsixArchive(String),
    #[error("Missing package.json manifest inside VSIX archive")]
    MissingVsixManifest,
    #[error("I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

mod conventions;
mod jsonc;
mod keybindings;
mod mcp;
mod one_click;
mod paths;
mod settings;
mod vsix;

pub use conventions::*;
pub use jsonc::*;
pub use keybindings::*;
pub use mcp::*;
pub use one_click::*;
pub use paths::*;
pub use settings::*;
pub use vsix::*;

#[cfg(test)]
mod tests;
