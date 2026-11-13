//! The 5 Coloride validation states and the task lifecycle (`LOT-002`).

use super::*;

// ============================================================================
// 2. Canonical Coloride Validation States (5 States) & Task Lifecycle (11 States)
// ============================================================================

/// The 5 canonical Coloride validation states bound to the exact document revision hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum ColorideValidationState {
    /// `🟢 ✓ Validated`: build OK, `vtsls`/Biome 0 errors, 100% impacted tests passed, Preview 0 crash/`console.error`.
    ValidatedGreen,
    /// `🟡 ! Needs Review`: agent patch awaiting human review, architectural decision, or non-blocking warning.
    ReviewYellow,
    /// `🔴 ✕ Failed`: compilation error, `vtsls` type error, blocking Biome rule, test failure, or runtime crash.
    FailedRed,
    /// `🟠 ⟳ Stale Validation`: previously `ValidatedGreen` range modified locally by the user after validation.
    StaleOrange,
    /// `🔵 • Unchanged Source`: original or infrastructure source code untouched by the current task.
    UnchangedBlue,
}

impl ColorideValidationState {
    pub const ALL: [Self; 5] = [
        Self::ValidatedGreen,
        Self::ReviewYellow,
        Self::FailedRed,
        Self::StaleOrange,
        Self::UnchangedBlue,
    ];

    #[must_use]
    pub const fn icon(self) -> &'static str {
        match self {
            Self::ValidatedGreen => "✓",
            Self::ReviewYellow => "!",
            Self::FailedRed => "✕",
            Self::StaleOrange => "⟳",
            Self::UnchangedBlue => "•",
        }
    }

    #[must_use]
    pub const fn label_fr(self) -> &'static str {
        match self {
            Self::ValidatedGreen => "✓ Validé",
            Self::ReviewYellow => "! À examiner",
            Self::FailedRed => "✕ Échec",
            Self::StaleOrange => "⟳ Validation périmée",
            Self::UnchangedBlue => "• Source inchangée",
        }
    }

    #[must_use]
    pub const fn label_en(self) -> &'static str {
        match self {
            Self::ValidatedGreen => "✓ Validated",
            Self::ReviewYellow => "! Needs Review",
            Self::FailedRed => "✕ Failed",
            Self::StaleOrange => "⟳ Stale Validation",
            Self::UnchangedBlue => "• Unchanged Source",
        }
    }

    #[must_use]
    pub const fn label_es(self) -> &'static str {
        match self {
            Self::ValidatedGreen => "✓ Validado",
            Self::ReviewYellow => "! Revisar",
            Self::FailedRed => "✕ Fallo",
            Self::StaleOrange => "⟳ Caducado",
            Self::UnchangedBlue => "• Sin cambios",
        }
    }

    /// Synchronously downgrades `ValidatedGreen` to `StaleOrange` upon any local character edit.
    #[must_use]
    pub const fn on_local_edit(self) -> Self {
        match self {
            Self::ValidatedGreen => Self::StaleOrange,
            other => other,
        }
    }
}

/// The 11-state task lifecycle machine (`LOT-002` / `LOT-013`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum TaskState {
    Created,
    ContextReady,
    Planned,
    Running,
    Verifying,
    AwaitingReview,
    Applied,
    Paused,
    Failed,
    Cancelled,
    NeedsReconciliation,
}

impl TaskState {
    pub const ALL: [Self; 11] = [
        Self::Created,
        Self::ContextReady,
        Self::Planned,
        Self::Running,
        Self::Verifying,
        Self::AwaitingReview,
        Self::Applied,
        Self::Paused,
        Self::Failed,
        Self::Cancelled,
        Self::NeedsReconciliation,
    ];

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Applied | Self::Failed | Self::Cancelled)
    }

    #[must_use]
    pub const fn requires_human_intervention(self) -> bool {
        matches!(
            self,
            Self::AwaitingReview | Self::Paused | Self::NeedsReconciliation
        )
    }
}
