//! Contract #6: `ToolCall`.

use super::*;

// ============================================================================
// 8. Contract #6 — ToolCall
// ============================================================================

/// Strongly-typed argument value for a `ToolCall` (avoids `any` in TypeScript).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum ToolArgValue {
    Text(String),
    Integer(i32),
    Boolean(bool),
    StringList(Vec<String>),
}

/// Capability required by a `ToolCall` and checked by `PolicyEngine`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum ToolCapability {
    ReadWorkspace,
    WriteWorktree,
    RunSandboxCommand,
    QueryLocalMcp,
    NetworkEgress,
    DatabaseRead,
    DatabaseMigrate,
    DeployPreview,
    DeployProduction,
}

/// Precondition that must hold before `ToolBroker` executes a `ToolCall`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ToolPrecondition {
    pub description: String,
    pub required_snapshot_hash: Option<String>,
    pub requires_human_approval: bool,
}

/// Contract #6: Structured, idempotent tool invocation submitted to `PolicyEngine` and `ToolBroker`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ToolCall {
    pub schema_version: u16,
    pub call_id: String,
    pub task_id: String,
    pub tool_name: String,
    pub validated_args: BTreeMap<String, ToolArgValue>,
    pub required_capabilities: Vec<ToolCapability>,
    pub preconditions: Vec<ToolPrecondition>,
    pub idempotency_key: String,
}
