//! Capability skeleton only; no OS sandbox runner can execute commands yet.
//! Health-check targets are configuration, not measured execution guarantees.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OsSandboxKind {
    MacOsSeatbelt,
    LinuxLandlockBubblewrap,
    WindowsAppContainerJobObject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxCapabilities {
    pub subsystem: String,
    pub native_os_kind: OsSandboxKind,
    pub fail_closed_enforced: bool,
    pub target_startup_ms: u32,
    /// False until the native runner can actually create and verify the requested isolation.
    pub execution_available: bool,
}

pub fn detect_native_os_sandbox() -> OsSandboxKind {
    if cfg!(target_os = "macos") {
        OsSandboxKind::MacOsSeatbelt
    } else if cfg!(target_os = "windows") {
        OsSandboxKind::WindowsAppContainerJobObject
    } else {
        OsSandboxKind::LinuxLandlockBubblewrap
    }
}

pub fn healthcheck() -> SandboxCapabilities {
    SandboxCapabilities {
        subsystem: "sandbox-runner".to_string(),
        native_os_kind: detect_native_os_sandbox(),
        fail_closed_enforced: true,
        target_startup_ms: 5,
        execution_available: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_runner_enforces_fail_closed_invariant() {
        let caps = healthcheck();
        assert_eq!(caps.subsystem, "sandbox-runner");
        assert!(caps.fail_closed_enforced);
        assert!(!caps.execution_available);
        assert!(caps.target_startup_ms <= 5);
    }
}
