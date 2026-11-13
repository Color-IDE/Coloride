// Public surface of 1-click onboarding (LOT-006); parsers and scanners stay internal.
export { REDACTED_ENV_VALUE } from "../security/secrets.js";
export { createInitialOnboardingState, OnboardingModalController } from "./controller.js";
export { resolveExternalIdePaths } from "./ide-paths.js";
export { parseJsonc, sanitizeJsoncToJson } from "./jsonc.js";
export type * from "./types.js";
export { parseDeclarativeVsixPackage } from "./vsix-import.js";
