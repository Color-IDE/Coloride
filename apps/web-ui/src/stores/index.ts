import { createWorkspaceNavigation } from "../workspace-navigation.js";
import { createActivityActions } from "./activity-actions.js";
import { createAgentQueueActions } from "./agent-queue.js";
import { createChatActions } from "./chat-actions.js";
import type { StoreContext } from "./context.js";
import { createDocumentActions } from "./documents.js";
import { createExplorerActions } from "./explorer-actions.js";
import { createInitialStores } from "./initial-state.js";
import { createSearchActions } from "./search.js";
import type { CockpitStoreBundle, CockpitStoreOptions } from "./types.js";

export {
  extractSymbolsHeuristically as extractAstSymbolsFromSource,
  inferImpactedTestsHeuristically as computeImpactedTestsForBuffer,
} from "../cockpit-analysis.js";
export { AtomicStore, type StoreListener } from "../atomic-store.js";
export { COLORIDE_DESIGN_TOKENS, type DesignStateTokens } from "../design-state-tokens.js";
export type { AreaSize } from "../layout-tree.js";
export type { WorkGroup, WorkspaceNavigationState } from "../workspace-navigation.js";
export { resolveGroupLayout } from "../workspace-navigation.js";
export type * from "./types.js";

/**
 * The cockpit state: one atomic store per zone plus the actions that change them, grouped by
 * concern (activity bar, sessions, documents, explorer, search, agent queue, navigation).
 */
export function createCockpitStoreBundle(options?: CockpitStoreOptions): CockpitStoreBundle {
  const { zone1, zone2, zone3, zone4, documents, initialChats } = createInitialStores(options);

  const navigationActions = createWorkspaceNavigation(
    options?.initialNavigation,
    initialChats.map((chat) => chat.chatId),
    () => zone3.getState().chats.map((chat) => chat.chatId),
    (chatId) => bundle.selectChat(chatId),
  );

  const ctx: StoreContext = {
    zone1,
    zone2,
    zone3,
    zone4,
    navigation: navigationActions.navigation,
    documents,
    bundle: () => bundle,
  };

  const bundle: CockpitStoreBundle = {
    ...navigationActions,
    zone1,
    zone2,
    zone3,
    zone4,
    ...createActivityActions(ctx),
    ...createChatActions(ctx),
    ...createDocumentActions(ctx),
    ...createExplorerActions(ctx),
    ...createSearchActions(ctx),
    ...createAgentQueueActions(ctx),
  };
  return bundle;
}
