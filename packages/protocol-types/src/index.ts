import {
  type Approval,
  CONTRACT_SCHEMA_VERSION,
  type ColorideValidationState,
  type TargetEnvironment,
  type TaskState,
} from "./generated.js";

export * from "./generated.js";

export const COLORIDE_VALIDATION_STATES: readonly ColorideValidationState[] = [
  "ValidatedGreen",
  "ReviewYellow",
  "FailedRed",
  "StaleOrange",
  "UnchangedBlue",
] as const;

export const TASK_STATES: readonly TaskState[] = [
  "Created",
  "ContextReady",
  "Planned",
  "Running",
  "Verifying",
  "AwaitingReview",
  "Applied",
  "Paused",
  "Failed",
  "Cancelled",
  "NeedsReconciliation",
] as const;

export interface ValidationBadgeMeta {
  readonly state: ColorideValidationState;
  readonly icon: "✓" | "!" | "✕" | "⟳" | "•";
  readonly labelFr: string;
  readonly labelEn: string;
  readonly labelEs: string;
}

export const COLORIDE_STATE_META: Record<ColorideValidationState, ValidationBadgeMeta> = {
  ValidatedGreen: {
    state: "ValidatedGreen",
    icon: "✓",
    labelFr: "✓ Validé",
    labelEn: "✓ Validated",
    labelEs: "✓ Validado",
  },
  ReviewYellow: {
    state: "ReviewYellow",
    icon: "!",
    labelFr: "! À examiner",
    labelEn: "! Needs Review",
    labelEs: "! Revisar",
  },
  FailedRed: {
    state: "FailedRed",
    icon: "✕",
    labelFr: "✕ Échec",
    labelEn: "✕ Failed",
    labelEs: "✕ Fallo",
  },
  StaleOrange: {
    state: "StaleOrange",
    icon: "⟳",
    labelFr: "⟳ Validation périmée",
    labelEn: "⟳ Stale Validation",
    labelEs: "⟳ Caducado",
  },
  UnchangedBlue: {
    state: "UnchangedBlue",
    icon: "•",
    labelFr: "• Source inchangée",
    labelEn: "• Unchanged Source",
    labelEs: "• Sin cambios",
  },
};

/**
 * TypeScript counterpart of `Approval::is_valid_for` in `crates/host-core/src/contracts.rs`.
 * Invalidates the approval if expired, if the target environment differs, or if `actionDigest`
 * differs by even a single bit from `approval.approved_digest`.
 */
export function isApprovalValidFor(
  approval: Approval,
  targetEnv: TargetEnvironment,
  actionDigest: string,
  now: number,
): boolean {
  if (approval.schema_version !== CONTRACT_SCHEMA_VERSION) {
    return false;
  }
  if (approval.actor_identity.trim().length === 0 || approval.approved_digest.length === 0) {
    return false;
  }
  if (now >= approval.expires_at) {
    return false;
  }
  if (approval.target_env !== targetEnv) {
    return false;
  }
  if (approval.approved_digest.length !== actionDigest.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < approval.approved_digest.length; i += 1) {
    diff |= approval.approved_digest.charCodeAt(i) ^ actionDigest.charCodeAt(i);
  }
  return diff === 0;
}
