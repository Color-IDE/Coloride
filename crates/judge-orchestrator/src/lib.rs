use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JudgeHealthStatus {
    pub subsystem: String,
    pub max_auto_retries: u8,
    pub deterministic_evidence_required: bool,
}

pub fn healthcheck() -> JudgeHealthStatus {
    JudgeHealthStatus {
        subsystem: "judge-orchestrator".to_string(),
        max_auto_retries: 2,
        deterministic_evidence_required: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn judge_orchestrator_healthcheck_enforces_two_retries_limit() {
        let status = healthcheck();
        assert_eq!(status.subsystem, "judge-orchestrator");
        assert_eq!(status.max_auto_retries, 2);
        assert!(status.deterministic_evidence_required);
    }
}
