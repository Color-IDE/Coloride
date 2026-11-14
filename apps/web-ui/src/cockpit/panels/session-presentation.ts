import type { CockpitChatTab } from "../../stores/index.js";
import { CODEX_ICON, TERMINAL_ICON } from "./panel-icons.js";

/** Session identity is independent of a shell name or an agent's display title. */
export function sessionIcon(session: CockpitChatTab): string | null {
  if (session.kind === "terminal") return TERMINAL_ICON;
  return session.modelName === "Codex" ? CODEX_ICON : null;
}
