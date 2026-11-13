import type { StoreContext } from "./context.js";
import type {
  ActivityBarSection,
  CockpitPersonaMode,
  CockpitStoreBundle,
  InspectorTab,
} from "./types.js";

type ActivityActions = Pick<
  CockpitStoreBundle,
  | "setActivitySection"
  | "handleActivityBarShortcut"
  | "setPersona"
  | "toggleSidebar"
  | "toggleInspector"
  | "setUiZoomPercent"
  | "setInspectorTab"
>;

const SECTION_BY_DIGIT: Record<string, ActivityBarSection> = {
  "1": "sessions",
  "2": "files",
  "3": "search",
  "4": "git",
  "5": "debug",
  "6": "mcp",
};

/** Zone 1 (activity bar, persona, panel visibility, zoom) and the Zone 4 tab selector. */
export function createActivityActions(ctx: StoreContext): ActivityActions {
  const { zone1, zone3, zone4, documents } = ctx;

  const setActivitySection = (section: ActivityBarSection): void => {
    if (section === "debug") {
      const activeDocId = zone4.getState().activeDocumentId;
      const activeContent = documents.get(activeDocId)?.content ?? "";
      ctx.bundle().refreshAstAndImpactedTests(activeDocId, activeContent);
    }
    zone1.setState((prev) => ({
      ...prev,
      activeSection: section,
      sidebarOpen: true,
    }));
  };

  return {
    setActivitySection,

    handleActivityBarShortcut(key: string, metaOrCtrlKey: boolean): boolean {
      if (!metaOrCtrlKey) {
        return false;
      }
      const target = SECTION_BY_DIGIT[key];
      if (!target) {
        return false;
      }
      setActivitySection(target);
      return true;
    },

    /**
     * Explicit persona selector per workspace (`Create | Learn | Develop | Infrastructure | Data`).
     * Invariants enforced:
     * 1. No panel ever disappears automatically during an active task.
     * 2. The file tree remains accessible in all personas (`fileTreeAccessible: true`).
     * 3. Changing persona never alters execution permissions (`permissionsLevel: "standard-enforced"`).
     */
    setPersona(persona: CockpitPersonaMode, duringActiveTask = false): void {
      const hasRunningTask = duringActiveTask || zone3.getState().activeRunningAgentChatId !== null;
      zone1.setState((prev) => ({
        ...prev,
        activePersona: persona,
        // Never hide sidebar automatically during a task; keep open if already open or in Develop mode
        sidebarOpen: hasRunningTask ? prev.sidebarOpen : prev.sidebarOpen || persona === "Develop",
        fileTreeAccessible: true,
        permissionsLevel: "standard-enforced",
      }));
    },

    toggleSidebar(open?: boolean): void {
      zone1.setState((prev) => ({
        ...prev,
        sidebarOpen: open ?? !prev.sidebarOpen,
      }));
    },

    toggleInspector(open?: boolean): void {
      zone1.setState((prev) => ({
        ...prev,
        inspectorOpen: open ?? !prev.inspectorOpen,
      }));
    },

    setUiZoomPercent(zoomPercent: number): void {
      const clamped = Math.min(200, Math.max(50, Math.round(zoomPercent)));
      zone1.setState((prev) => ({
        ...prev,
        uiZoomPercent: clamped,
      }));
    },

    setInspectorTab(tab: InspectorTab): void {
      zone4.setState((prev) => ({
        ...prev,
        activeInspectorTab: tab,
      }));
    },
  };
}
