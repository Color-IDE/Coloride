import type { DocumentDiagnostics, LanguageFeatureResponse } from "@coloride/protocol-types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import "@coloride/web-ui/theme.css";
import type { NativeMigrationReport, WorkspaceTrustReport } from "@coloride/web-ui";
import {
  type BackgroundServicesState,
  decodeWorkspaceSessionCacheBinary,
  encodeWorkspaceSessionCacheBinary,
  lazyBootDesktopCockpit,
} from "./index.js";
import "./shell.css";
import { TauriBinaryHostBridge } from "./tauri-binary-host-bridge.js";

interface NativeWorkspaceNode {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly isDirectory: boolean;
}

interface NativeSearchResult {
  readonly filePath: string;
  readonly line: number;
  readonly snippet: string;
  readonly freshness: "LiveUnsavedBuffer" | "IndexedCommit" | "StaleNeedsReindex";
  readonly score: number;
  readonly secretsRedacted: number;
}

interface NativeAstAnalysis {
  readonly symbols: ReadonlyArray<{
    readonly name: string;
    readonly kind: "function" | "component" | "class" | "interface" | "type" | "const";
    readonly line: number;
    readonly exported: boolean;
    readonly confidence: "ExactAstLsp" | "HeuristicText";
  }>;
  readonly impactedTests: ReadonlyArray<{
    readonly testFilePath: string;
    readonly coveredSymbol: string;
    readonly confidence: "ExactAstLsp" | "HeuristicText";
  }>;
}

/** Carries one tool's diagnostics for one revision of one document (see `lsp/session.rs`). */
const DOCUMENT_DIAGNOSTICS_EVENT = "coloride-document-diagnostics";

/** Sent by the Rust side when closing or quitting was held back because of unsaved changes. */
const CLOSE_REQUESTED_EVENT = "coloride-close-requested";

function mapWorkspaceNodes(nodes: readonly NativeWorkspaceNode[]) {
  return nodes.map((node) => ({
    ...node,
    validationState: "UnchangedBlue" as const,
  }));
}

function ColorideDesktopApp() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let desktop: ReturnType<typeof lazyBootDesktopCockpit> | undefined;
    let sessionPersistenceTimer: number | undefined;
    let stopListeningForClose: (() => void) | undefined;
    let stopListeningForDiagnostics: (() => void) | undefined;
    const persistSession = () => {
      if (!desktop) return;
      const payload = Array.from(desktop.exportSessionCacheBinary());
      void invoke("save_session_cache_command", { payload });
    };

    void invoke<number[] | null>("load_session_cache_command")
      .catch(() => null)
      .then(async (cachedBytes) => {
        if (cancelled) return;
        let validCachedBytes: Uint8Array | undefined;
        let restoredWorkspaceNodes: ReturnType<typeof mapWorkspaceNodes> | undefined;
        if (cachedBytes) {
          const candidate = Uint8Array.from(cachedBytes);
          try {
            const snapshot = decodeWorkspaceSessionCacheBinary(candidate);
            validCachedBytes = candidate;
            if (snapshot.workspaceRoot && snapshot.workspaceRoot !== "/workspace/coloride") {
              const nodes = await invoke<NativeWorkspaceNode[]>("load_workspace_command", {
                root: snapshot.workspaceRoot,
              }).catch(() => []);
              restoredWorkspaceNodes = mapWorkspaceNodes(nodes);
              if (
                !nodes.some((node) => !node.isDirectory && node.path === snapshot.activeDocumentId)
              ) {
                const firstFile = nodes.find((node) => !node.isDirectory);
                const activeDocumentId = firstFile?.path ?? "untitled:welcome.ts";
                const activeDocumentContent = firstFile
                  ? await invoke<string>("read_workspace_file_command", {
                      relativePath: firstFile.path,
                    }).catch(() => "")
                  : "// Empty workspace\n";
                validCachedBytes = encodeWorkspaceSessionCacheBinary({
                  ...snapshot,
                  activeDocumentId,
                  activeDocumentContent,
                });
              }
            }
          } catch {
            validCachedBytes = undefined;
          }
        }
        if (cancelled) return;
        const ipcChannel = new TauriBinaryHostBridge();
        desktop = lazyBootDesktopCockpit({
          rootContainer: host,
          ipcChannel,
          ...(validCachedBytes ? { cachedSessionBytes: validCachedBytes } : {}),
          ...(restoredWorkspaceNodes ? { initialFileTree: restoredWorkspaceNodes } : {}),
          openWorkspace: async () => {
            const selected = await open({ directory: true, multiple: false });
            if (!selected) return null;
            const nodes = await invoke<NativeWorkspaceNode[]>("load_workspace_command", {
              root: selected,
            });
            desktop?.setWorkspaceRoot(selected);
            void invoke("initialize_background_services_command");
            return mapWorkspaceNodes(nodes);
          },
          switchWorkspace: async (root) => {
            const nodes = await invoke<NativeWorkspaceNode[]>("load_workspace_command", { root });
            desktop?.setWorkspaceRoot(root);
            void invoke("initialize_background_services_command");
            return mapWorkspaceNodes(nodes);
          },
          readWorkspaceFile: (path) =>
            invoke<string>("read_workspace_file_command", { relativePath: path }),
          // Rust holds the window open while this is above zero (see commands/window.rs).
          onUnsavedCountChange: (count) => {
            void invoke("report_unsaved_buffers_command", { count });
          },
          // The decision is taken in a native dialog owned by the Rust side (commands/trust.rs).
          workspaceTrust: {
            getTrust: () => invoke<WorkspaceTrustReport>("workspace_trust_command"),
            requestTrust: async () => {
              const report = await invoke<WorkspaceTrustReport>("request_workspace_trust_command");
              // Services that were held back (language servers, linters) may start now.
              if (report.state === "Trusted") void invoke("initialize_background_services_command");
              return report;
            },
          },
          searchWorkspace: (query) =>
            invoke<NativeSearchResult[]>("search_workspace_command", { query, limit: 100 }),
          analyzeDocument: async (documentId, sessionGeneration) => {
            await ipcChannel.waitForDocumentReady();
            return invoke<NativeAstAnalysis>("analyze_document_command", {
              documentId,
              sessionGeneration,
            });
          },
          initializeBackgroundServices: () =>
            invoke<BackgroundServicesState>("initialize_background_services_command"),
          loadNativeMigrationReport: () =>
            invoke<NativeMigrationReport>("run_native_migration_command"),
        });
        // Completions, F12 and Shift+Alt+F, answered by vtsls/Biome about one exact revision.
        desktop.editorView.setLanguageFeatureProvider(
          (request) => invoke<LanguageFeatureResponse>("language_feature_command", { request }),
          (location) => {
            if (location.inside_workspace) {
              void desktop?.domController?.openWorkspaceFile(location.file_path);
            }
          },
        );
        sessionPersistenceTimer = window.setInterval(persistSession, 2_000);
        // The editor places each batch by its revision, and drops what its text has moved past.
        void listen<DocumentDiagnostics>(DOCUMENT_DIAGNOSTICS_EVENT, (event) => {
          desktop?.editorView.applyDocumentDiagnostics(event.payload);
        }).then((stopListening) => {
          if (cancelled) stopListening();
          else stopListeningForDiagnostics = stopListening;
        });
        // Closing or quitting with unsaved changes: ask here, then tell Rust to go ahead.
        void listen(CLOSE_REQUESTED_EVENT, async () => {
          const allowed = (await desktop?.domController?.confirmClose()) ?? true;
          if (!allowed) return;
          persistSession();
          await invoke("confirm_exit_command");
        }).then((stopListening) => {
          if (cancelled) stopListening();
          else stopListeningForClose = stopListening;
        });
      });

    return () => {
      cancelled = true;
      if (sessionPersistenceTimer !== undefined) window.clearInterval(sessionPersistenceTimer);
      stopListeningForClose?.();
      stopListeningForDiagnostics?.();
      if (desktop) {
        persistSession();
        desktop.destroy();
      }
    };
  }, []);

  return <div ref={hostRef} className="coloride-desktop-root" />;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root desktop mount point");

createRoot(rootElement).render(
  <StrictMode>
    <ColorideDesktopApp />
  </StrictMode>,
);
