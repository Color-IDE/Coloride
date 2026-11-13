import {
  type BinaryIpcChannel,
  ColorideEditorView,
  type EditorRangeDecoration,
  InMemoryBinaryHostBridge,
} from "@coloride/editor-cm6";
import { CONTRACT_SCHEMA_VERSION } from "@coloride/protocol-types";
import {
  type ActivityBarSection,
  type CockpitChatTab,
  CockpitDomController,
  type CockpitDomControllerOptions,
  type CockpitFileTreeNode,
  type CockpitPersonaMode,
  type CockpitStoreBundle,
  FrameBatchedStreamRenderer,
  type InspectorTab,
  type NativeMigrationReport,
  OnboardingModalController,
  type WorkspaceNavigationState,
  createCockpitStoreBundle,
  createInitialCockpitShellState,
  createInitialOnboardingState,
} from "@coloride/web-ui";

export const WORKSPACE_SESSION_CACHE_FILENAME = "workspace_session_cache.bin";

export interface WorkspaceSessionCacheSnapshot {
  readonly navigation?: WorkspaceNavigationState;
  readonly chats?: readonly CockpitChatTab[];
  readonly schemaVersion: number;
  readonly workspaceRoot: string;
  readonly activePersona: CockpitPersonaMode;
  readonly activeActivityPanel: ActivityBarSection;
  readonly activeInspectorTab: InspectorTab;
  readonly activeChatId: string;
  readonly activeDocumentId: string;
  readonly activeDocumentContent: string;
  readonly cursorUtf16Offset: number;
  readonly scrollTopPx: number;
  readonly uiZoomPercent: number;
  readonly sidebarVisible: boolean;
}

export interface BackgroundServicesState {
  readonly vtslsLspReady: boolean;
  readonly biomeDaemonReady: boolean;
  readonly sqliteFts5Ready: boolean;
  readonly sandboxWarmPoolReady: boolean;
}

export function encodeWorkspaceSessionCacheBinary(
  snapshot: WorkspaceSessionCacheSnapshot,
): Uint8Array {
  const json = JSON.stringify(snapshot);
  return new TextEncoder().encode(json);
}

export function decodeWorkspaceSessionCacheBinary(
  bytes: Uint8Array,
): WorkspaceSessionCacheSnapshot {
  const json = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(json) as WorkspaceSessionCacheSnapshot;
  if (parsed.schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported workspace_session_cache.bin schemaVersion ${parsed.schemaVersion}`,
    );
  }
  return parsed;
}

export interface LazyBootDesktopOptions {
  readonly rootContainer?: HTMLElement;
  readonly cachedSessionBytes?: Uint8Array;
  readonly initialChats?: readonly CockpitChatTab[];
  readonly initialFileTree?: readonly CockpitFileTreeNode[];
  readonly initialDecorations?: readonly EditorRangeDecoration[];
  readonly ipcChannel?: BinaryIpcChannel;
  readonly openWorkspace?: CockpitDomControllerOptions["openWorkspace"];
  readonly switchWorkspace?: CockpitDomControllerOptions["switchWorkspace"];
  readonly readWorkspaceFile?: CockpitDomControllerOptions["readWorkspaceFile"];
  readonly searchWorkspace?: CockpitDomControllerOptions["searchWorkspace"];
  readonly analyzeDocument?: CockpitDomControllerOptions["analyzeDocument"];
  readonly loadNativeMigrationReport?: () => Promise<NativeMigrationReport>;
  readonly initializeBackgroundServices?: () => Promise<BackgroundServicesState>;
}

export interface LazyBootDesktopHandle<TChannel extends BinaryIpcChannel = BinaryIpcChannel> {
  readonly appId: "dev.coloride.desktop";
  readonly bootToInteractiveMs: number;
  readonly restoredSessionCache: WorkspaceSessionCacheSnapshot;
  readonly ipcChannel: TChannel;
  readonly stores: CockpitStoreBundle;
  readonly editorView: ColorideEditorView;
  readonly onboardingController: OnboardingModalController;
  readonly streamRenderer: FrameBatchedStreamRenderer;
  readonly domController: CockpitDomController | null;
  getBackgroundServicesState(): BackgroundServicesState;
  waitForBackgroundServices(): Promise<BackgroundServicesState>;
  setWorkspaceRoot(workspaceRoot: string): void;
  exportSessionCacheBinary(): Uint8Array;
  destroy(): void;
}

/**
 * Execute the `LOT-005` Lazy Boot sequence in `desktop-tauri`:
 * 1. Immediately decode `workspace_session_cache.bin` (if provided) and restore window layout + active `ColorideEditorView` buffer (`p95 ≤ 3 s`).
 * 2. Schedule low-priority background initialization of `vtsls`, `Biome`, `SQLite FTS5`, and `Sandbox warm pool` after interactive boot.
 */
export function lazyBootDesktopCockpit(
  options?: LazyBootDesktopOptions & { readonly ipcChannel?: undefined },
): LazyBootDesktopHandle<InMemoryBinaryHostBridge>;
export function lazyBootDesktopCockpit<TChannel extends BinaryIpcChannel>(
  options: LazyBootDesktopOptions & { readonly ipcChannel: TChannel },
): LazyBootDesktopHandle<TChannel>;
export function lazyBootDesktopCockpit(
  options?: LazyBootDesktopOptions,
): LazyBootDesktopHandle<BinaryIpcChannel> {
  const t0 = performance.now();
  const defaultCache: WorkspaceSessionCacheSnapshot = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    workspaceRoot: "/workspace/coloride",
    activePersona: "Develop",
    activeActivityPanel: "sessions",
    activeInspectorTab: "code-diff",
    activeChatId: "chat-1",
    activeDocumentId: "src/auth/login.tsx",
    activeDocumentContent: "export function LoginView() {\n  return true;\n}\n",
    cursorUtf16Offset: 0,
    scrollTopPx: 0,
    uiZoomPercent: 100,
    sidebarVisible: true,
  };

  const restoredSessionCache = options?.cachedSessionBytes
    ? decodeWorkspaceSessionCacheBinary(options.cachedSessionBytes)
    : defaultCache;
  let workspaceRoot = restoredSessionCache.workspaceRoot;

  const ipcChannel = options?.ipcChannel ?? new InMemoryBinaryHostBridge();
  const stores = createCockpitStoreBundle({
    initialNavigation: restoredSessionCache.navigation,
    initialPersona: restoredSessionCache.activePersona,
    initialInspectorTab: restoredSessionCache.activeInspectorTab,
    initialActiveSection: restoredSessionCache.activeActivityPanel,
    initialActiveChatId: restoredSessionCache.activeChatId,
    initialActiveDocumentId: restoredSessionCache.activeDocumentId,
    initialChats: options?.initialChats ?? restoredSessionCache.chats,
    initialFileTree: options?.initialFileTree,
    initialUiZoomPercent: restoredSessionCache.uiZoomPercent,
  });

  if (!restoredSessionCache.sidebarVisible) {
    stores.toggleSidebar(false);
  }

  const editorView = new ColorideEditorView({
    initialDocumentId: restoredSessionCache.activeDocumentId,
    initialContent: restoredSessionCache.activeDocumentContent,
    ipcChannel,
    initialDecorations: options?.initialDecorations ?? [
      {
        fromLine: 1,
        toLine: 1,
        state: "UnchangedBlue",
        snapshotHash: "unvalidated-local-buffer",
      },
    ],
  });

  const onboardingController = new OnboardingModalController(editorView, {
    ...createInitialOnboardingState(),
    modalOpen: false,
  });
  if (options?.loadNativeMigrationReport) {
    onboardingController.setNativeImportLoader(options.loadNativeMigrationReport);
  }

  stores.setProjectPath(workspaceRoot === "/workspace/coloride" ? "" : workspaceRoot);

  const streamRenderer = new FrameBatchedStreamRenderer(stores.zone3);

  let domController: CockpitDomController | null = null;
  if (options?.rootContainer) {
    domController = new CockpitDomController({
      rootContainer: options.rootContainer,
      stores,
      editorView,
      onboardingController,
      ...(options?.openWorkspace ? { openWorkspace: options.openWorkspace } : {}),
      ...(options?.switchWorkspace ? { switchWorkspace: options.switchWorkspace } : {}),
      ...(options?.readWorkspaceFile ? { readWorkspaceFile: options.readWorkspaceFile } : {}),
      ...(options?.searchWorkspace ? { searchWorkspace: options.searchWorkspace } : {}),
      ...(options?.analyzeDocument ? { analyzeDocument: options.analyzeDocument } : {}),
    });
  }

  const bootToInteractiveMs = Math.max(0, performance.now() - t0);

  let bgState: BackgroundServicesState = {
    vtslsLspReady: false,
    biomeDaemonReady: false,
    sqliteFts5Ready: false,
    sandboxWarmPoolReady: false,
  };

  const bgPromise = options?.initializeBackgroundServices
    ? options.initializeBackgroundServices().then((state) => {
        bgState = state;
        return state;
      })
    : Promise.resolve().then(() => {
        bgState = {
          vtslsLspReady: true,
          biomeDaemonReady: true,
          sqliteFts5Ready: true,
          sandboxWarmPoolReady: true,
        };
        return bgState;
      });

  return {
    appId: "dev.coloride.desktop",
    bootToInteractiveMs,
    restoredSessionCache,
    ipcChannel,
    stores,
    editorView,
    onboardingController,
    streamRenderer,
    domController,
    getBackgroundServicesState(): BackgroundServicesState {
      return bgState;
    },
    waitForBackgroundServices(): Promise<BackgroundServicesState> {
      return bgPromise;
    },
    setWorkspaceRoot(nextWorkspaceRoot: string): void {
      workspaceRoot = nextWorkspaceRoot;
      stores.setProjectPath(nextWorkspaceRoot);
    },
    exportSessionCacheBinary(): Uint8Array {
      const z1 = stores.zone1.getState();
      const z2 = stores.zone2.getState();
      const z3 = stores.zone3.getState();
      const z4 = stores.zone4.getState();
      return encodeWorkspaceSessionCacheBinary({
        navigation: stores.navigation.getState(),
        chats: z3.chats,
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        workspaceRoot,
        activePersona: z1.activePersona,
        activeActivityPanel: z1.activeSection,
        activeInspectorTab: z4.activeInspectorTab,
        activeChatId: z3.activeChatId,
        activeDocumentId: z4.activeDocumentId,
        activeDocumentContent: editorView.getDocumentText(),
        cursorUtf16Offset: editorView.getEditorView().state.selection.main.head,
        scrollTopPx: z2.fileTreeScrollTop,
        uiZoomPercent: z1.uiZoomPercent,
        sidebarVisible: z1.sidebarOpen,
      });
    },
    destroy(): void {
      domController?.destroy();
      onboardingController.destroy();
      editorView.destroy();
    },
  };
}

export function bootstrapDesktopShell() {
  const ipcChannel = new InMemoryBinaryHostBridge();
  return {
    appId: "dev.coloride.desktop",
    shell: createInitialCockpitShellState(),
    ipcChannel,
    createIsolatedEditor(
      initialDocumentId: string,
      initialContent: string,
      initialDecorations: readonly EditorRangeDecoration[] = [],
    ): ColorideEditorView {
      return new ColorideEditorView({
        initialDocumentId,
        initialContent,
        ipcChannel,
        initialDecorations,
      });
    },
  };
}
