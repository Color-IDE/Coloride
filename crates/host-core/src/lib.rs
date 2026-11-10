pub mod contracts;

pub use contracts::*;

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
