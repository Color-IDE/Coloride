pub mod ast_graph;
pub mod secret_scanner;
pub mod sqlite_wal_store;

pub use ast_graph::*;
pub use secret_scanner::*;
pub use sqlite_wal_store::*;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextEngineStatus {
    pub subsystem: String,
    pub zero_mb_boot_ready: bool,
    pub mcp_local_target_ms: u32,
}

pub fn healthcheck() -> ContextEngineStatus {
    ContextEngineStatus {
        subsystem: "context-engine".to_string(),
        zero_mb_boot_ready: true,
        mcp_local_target_ms: 20,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_engine_healthcheck_reports_ready() {
        let status = healthcheck();
        assert_eq!(status.subsystem, "context-engine");
        assert!(status.zero_mb_boot_ready);
        assert!(status.mcp_local_target_ms <= 20);
    }
}
