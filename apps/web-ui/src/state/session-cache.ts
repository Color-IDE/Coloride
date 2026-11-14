import type { CockpitChatTab } from "../stores/types.js";
import { COLORIDE_DESIGN_TOKENS } from "../ui/design-state-tokens.js";

/** Upgrade old JSON sessions once; live stores never infer kind from a model label. */
export function restoreCachedSession(value: unknown): CockpitChatTab {
  if (!value || typeof value !== "object") throw new Error("Invalid cached session");
  const legacy = value as Record<string, unknown>;
  if (
    typeof legacy.chatId !== "string" ||
    typeof legacy.title !== "string" ||
    typeof legacy.validationState !== "string" ||
    !Object.hasOwn(COLORIDE_DESIGN_TOKENS, legacy.validationState)
  ) {
    throw new Error("Invalid cached session identity");
  }
  const common = {
    chatId: legacy.chatId,
    title: legacy.title,
    validationState: legacy.validationState as CockpitChatTab["validationState"],
    ...(typeof legacy.targetDocumentId === "string"
      ? { targetDocumentId: legacy.targetDocumentId }
      : {}),
    ...(typeof legacy.targetDocumentContent === "string"
      ? { targetDocumentContent: legacy.targetDocumentContent }
      : {}),
    ...(typeof legacy.previewUrl === "string" ? { previewUrl: legacy.previewUrl } : {}),
  };
  if (legacy.kind === "terminal" || (legacy.kind === undefined && legacy.modelName === "Shell")) {
    return { ...common, kind: "terminal" };
  }
  if (legacy.kind !== undefined && legacy.kind !== "agent")
    throw new Error("Unsupported cached session kind");
  if (typeof legacy.modelName !== "string" || legacy.modelName.length === 0)
    throw new Error("Agent session requires a model");
  const status = legacy.agentExecutionStatus;
  return {
    ...common,
    kind: "agent",
    modelName: legacy.modelName,
    ...(status === "Idle" || status === "Running" || status === "QueuedSequential"
      ? { agentExecutionStatus: status }
      : {}),
  };
}
