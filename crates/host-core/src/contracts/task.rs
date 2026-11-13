//! Contract #3: `TaskSpec` and its execution policy.

use super::*;

// ============================================================================
// 5. Contract #3 — TaskSpec
// ============================================================================

/// Execution target environment governed by `PolicyEngine` and `Approval`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum TargetEnvironment {
    LocalWorktree,
    LocalOciSandbox,
    Staging,
    Production,
    SanitizedDatabaseClone,
}

/// Autonomy level granted to an agent for a specific task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum AutonomyLevel {
    ProposalOnly,
    SupervisedSandbox,
    BoundedAutoCorrect,
}

/// Deterministic security and execution policy attached to a `TaskSpec`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ExecutionPolicy {
    pub autonomy_level: AutonomyLevel,
    pub network_allowed: bool,
    pub allowed_paths: Vec<String>,
    pub forbidden_paths: Vec<String>,
    pub max_auto_retries: u8,
    pub workspace_trusted: bool,
}

/// Resource and financial budget ceiling for a task (`BudgetLedger`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct BudgetLimits {
    pub max_cost_usd_micros: u32,
    pub max_tokens: u32,
    pub max_cpu_ms: u32,
    pub max_tool_calls: u32,
}

/// Contract #3: Specification, policy, and budget boundaries for an agent task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TaskSpec {
    pub schema_version: u16,
    pub task_id: String,
    pub objective: String,
    pub workspace_id: String,
    pub base_snapshot_id: String,
    pub target_env: TargetEnvironment,
    pub policy: ExecutionPolicy,
    pub budget_limits: BudgetLimits,
    pub acceptance_criteria: Vec<String>,
    pub state: TaskState,
}
