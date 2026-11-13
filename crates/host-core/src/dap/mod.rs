//! JavaScript/TypeScript debugging through the Debug Adapter Protocol (`LOT-010`), with
//! vscode-js-debug's DAP server (`scripts/fetch-js-debug.mjs`).

mod connection;
mod session;

use thiserror::Error;

pub use connection::{DapConnection, DapHandler, DapIncoming};
pub use session::{
    DebugCommand, DebugEvent, DebugEventSink, DebugLaunch, DebugSession, DebugSessionRole,
    DEBUG_EVENT_FRAME,
};

use crate::lsp::LspError;
use crate::process::SupervisionError;
use crate::trust::TrustError;

#[derive(Debug, Error)]
pub enum DebugError {
    #[error(transparent)]
    Trust(#[from] TrustError),
    #[error(transparent)]
    Supervision(#[from] SupervisionError),
    #[error("the program to debug must be a file inside the workspace")]
    ProgramOutsideWorkspace,
    #[error("debug adapter I/O error: {0}")]
    Io(String),
    #[error("the debug adapter did not start: {0}")]
    AdapterStart(String),
    #[error("debug adapter disconnected")]
    Disconnected,
    #[error("debug adapter did not answer `{command}` in time")]
    Timeout { command: String },
    #[error("debug adapter refused `{command}`: {message}")]
    Adapter { command: String, message: String },
    #[error("no program is being debugged yet")]
    NoDebuggee,
}

impl DebugError {
    pub(crate) fn io(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

impl From<LspError> for DebugError {
    fn from(error: LspError) -> Self {
        match error {
            LspError::Trust(error) => Self::Trust(error),
            other => Self::AdapterStart(other.to_string()),
        }
    }
}
