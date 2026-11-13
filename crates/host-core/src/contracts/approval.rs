//! Contract #9: `Approval`, bound to the exact revision hash.

use super::*;

// ============================================================================
// 11. Contract #9 — Approval
// ============================================================================

/// Kind of privileged action covered by a signed `Approval`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum ApprovalActionKind {
    ApplyChangeSet,
    ExecuteToolCall,
    RunDatabaseMigration,
    DeployInfrastructure,
    PublishRelease,
}

/// Contract #9: Cryptographic approval bound to a specific actor, target, action, and digest.
/// Any 1-bit change in the patch, plan, or target environment immediately invalidates the approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Approval {
    pub schema_version: u16,
    pub approval_id: String,
    pub actor_identity: String,
    pub target_env: TargetEnvironment,
    pub action_kind: ApprovalActionKind,
    pub approved_digest: String,
    #[ts(type = "number")]
    pub expires_at: u64,
}

impl Approval {
    /// Computes a domain-separated BLAKE3 digest binding the changeset/patch digest,
    /// execution plan digest, target environment, and action kind.
    #[must_use]
    pub fn compute_action_digest(
        changeset_digest: &str,
        plan_digest: &str,
        target_env: &TargetEnvironment,
        action_kind: &ApprovalActionKind,
    ) -> String {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"coloride.approval.v1\0");
        hasher.update(changeset_digest.as_bytes());
        hasher.update(b"\0");
        hasher.update(plan_digest.as_bytes());
        hasher.update(b"\0");
        if let Ok(env_bytes) = bincode::serialize(target_env) {
            hasher.update(&env_bytes);
        }
        hasher.update(b"\0");
        if let Ok(kind_bytes) = bincode::serialize(action_kind) {
            hasher.update(&kind_bytes);
        }
        hasher.finalize().to_hex().to_string()
    }

    /// Validates whether this approval authorizes `action_digest` on `target_env` at timestamp `now`.
    /// Returns `false` if expired (`now >= self.expires_at`), if `target_env` differs, or if
    /// `action_digest` differs by even a single bit from `self.approved_digest`.
    #[must_use]
    pub fn is_valid_for(
        &self,
        target_env: &TargetEnvironment,
        action_digest: &str,
        now: u64,
    ) -> bool {
        if self.schema_version != CONTRACT_SCHEMA_VERSION {
            return false;
        }
        if self.actor_identity.trim().is_empty() || self.approved_digest.is_empty() {
            return false;
        }
        if now >= self.expires_at {
            return false;
        }
        if &self.target_env != target_env {
            return false;
        }
        constant_time_str_eq(&self.approved_digest, action_digest)
    }

    /// Validates this approval against the raw `changeset_digest`, `plan_digest`, `target_env`, and `action_kind`.
    #[must_use]
    pub fn is_valid_for_plan_and_patch(
        &self,
        target_env: &TargetEnvironment,
        action_kind: &ApprovalActionKind,
        changeset_digest: &str,
        plan_digest: &str,
        now: u64,
    ) -> bool {
        if &self.action_kind != action_kind {
            return false;
        }
        let expected_digest =
            Self::compute_action_digest(changeset_digest, plan_digest, target_env, action_kind);
        self.is_valid_for(target_env, &expected_digest, now)
    }
}

fn constant_time_str_eq(lhs: &str, rhs: &str) -> bool {
    let lhs_bytes = lhs.as_bytes();
    let rhs_bytes = rhs.as_bytes();
    if lhs_bytes.len() != rhs_bytes.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&a, &b) in lhs_bytes.iter().zip(rhs_bytes.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}
