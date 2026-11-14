import type { AtomicStore } from "../state/atomic-store.js";
import type { WorkspaceNavigationState } from "../state/workspace-navigation.js";
import type { DocumentBuffers } from "./documents.js";
import type {
  CockpitStoreBundle,
  Zone1ActivityState,
  Zone2SidebarState,
  Zone3MultiChatState,
  Zone4InspectorState,
} from "./types.js";

/** What every group of store actions works on. */
export interface StoreContext {
  readonly zone1: AtomicStore<Zone1ActivityState>;
  readonly zone2: AtomicStore<Zone2SidebarState>;
  readonly zone3: AtomicStore<Zone3MultiChatState>;
  readonly zone4: AtomicStore<Zone4InspectorState>;
  readonly navigation: AtomicStore<WorkspaceNavigationState>;
  /** In-memory text of every document the cockpit has shown, by relative path. */
  readonly documents: DocumentBuffers;
  /** The assembled bundle, for actions that call actions of another group. */
  readonly bundle: () => CockpitStoreBundle;
}
