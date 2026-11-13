pub mod contracts;
pub mod document;
pub mod journal;
pub mod lazy_boot;
pub mod lsp;
pub mod migration;
pub mod offsets;
pub mod process;
pub mod terminal;
pub mod trust;

pub use contracts::*;
pub use document::*;
pub use journal::*;
pub use lazy_boot::*;
pub use lsp::*;
pub use migration::*;
pub use offsets::*;
pub use process::*;
pub use terminal::*;
pub use trust::*;

/// Re-exported so that crates handling document text use the same `Rope` type.
pub use ropey;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostHealthStatus {
    pub subsystem: String,
    pub version: String,
    pub ready: bool,
}

pub fn healthcheck() -> HostHealthStatus {
    HostHealthStatus {
        subsystem: "host-core".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        ready: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_core_healthcheck_reports_ready() {
        let status = healthcheck();
        assert_eq!(status.subsystem, "host-core");
        assert!(status.ready);
        assert_eq!(status.version, "0.1.0");
    }
}
