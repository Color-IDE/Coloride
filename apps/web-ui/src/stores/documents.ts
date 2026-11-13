import type { ColorideValidationState } from "@coloride/protocol-types";
import {
  extractSymbolsHeuristically,
  inferImpactedTestsHeuristically,
} from "../cockpit-analysis.js";
import type { StoreContext } from "./context.js";
import type { CockpitStoreBundle } from "./types.js";

export interface DocumentBuffer {
  content: string;
  unsaved: boolean;
  validationState: ColorideValidationState;
}

/** In-memory text of the documents shown so far, by relative path. */
export type DocumentBuffers = Map<string, DocumentBuffer>;

type DocumentActions = Pick<
  CockpitStoreBundle,
  | "selectFileFromTree"
  | "getDocumentContent"
  | "updateInMemoryDocumentContent"
  | "isDocumentUnsaved"
  | "getUnsavedDocumentIds"
  | "discardDocumentBuffer"
  | "markDocumentSaved"
>;

/** Document buffers, and showing a file of the tree in Zone 4. */
export function createDocumentActions(ctx: StoreContext): DocumentActions {
  const { zone2, zone4, documents } = ctx;
  return {
    /**
     * Open a file clicked in the Zone 2 File Tree inside the Zone 4 CodeMirror 6 Inspector in `< 10 ms`.
     */
    selectFileFromTree(filePath: string, contentOverride?: string): number {
      const t0 = performance.now();
      const z2 = zone2.getState();
      const fileIdx = z2.fileTree.findIndex((n) => n.path === filePath);
      const treeNode = fileIdx >= 0 ? z2.fileTree[fileIdx] : undefined;
      const existing = documents.get(filePath);
      const content =
        contentOverride ?? existing?.content ?? `export const filePath = "${filePath}";\n`;
      const validationState =
        existing?.validationState ?? treeNode?.validationState ?? "UnchangedBlue";

      documents.set(filePath, {
        content,
        // Content passed in is fresh from disk: it replaces (never inherits) a buffer's edits.
        unsaved: contentOverride === undefined ? (existing?.unsaved ?? false) : false,
        validationState,
      });

      const astSymbols = extractSymbolsHeuristically(content);
      const impactedTests = inferImpactedTestsHeuristically(filePath, astSymbols, z2.fileTree);

      zone2.setState((prev) => ({
        ...prev,
        focusedFileIndex: fileIdx >= 0 ? fileIdx : prev.focusedFileIndex,
        astSymbols,
        impactedTests,
      }));

      const syncDurationMs = Math.max(0, performance.now() - t0);
      zone4.setState((prev) => ({
        ...prev,
        activeDocumentId: filePath,
        activeValidationState: validationState,
        lastSyncDurationMs: syncDurationMs,
        hasUnsavedChanges: existing?.unsaved ?? false,
      }));

      return syncDurationMs;
    },

    getDocumentContent(filePath: string): string | undefined {
      return documents.get(filePath)?.content;
    },

    updateInMemoryDocumentContent(
      filePath: string,
      content: string,
      hasUnsavedChanges = true,
    ): void {
      const existing = documents.get(filePath);
      const prevValidation = existing?.validationState ?? zone4.getState().activeValidationState;
      // Editing a ValidatedGreen range downgrades it synchronously (AGENTS.md rule 4).
      const nextValidation: ColorideValidationState =
        hasUnsavedChanges && prevValidation === "ValidatedGreen" ? "StaleOrange" : prevValidation;

      documents.set(filePath, {
        content,
        unsaved: hasUnsavedChanges,
        validationState: nextValidation,
      });
    },

    isDocumentUnsaved(filePath: string): boolean {
      return documents.get(filePath)?.unsaved ?? false;
    },

    getUnsavedDocumentIds(): string[] {
      return [...documents].filter(([, buffer]) => buffer.unsaved).map(([id]) => id);
    },

    discardDocumentBuffer(filePath: string): void {
      documents.delete(filePath);
    },

    markDocumentSaved(filePath: string): void {
      const existing = documents.get(filePath);
      if (existing) {
        documents.set(filePath, {
          ...existing,
          unsaved: false,
        });
      }
      if (zone4.getState().activeDocumentId === filePath) {
        zone4.setState((prev) => ({
          ...prev,
          hasUnsavedChanges: false,
        }));
      }
    },
  };
}
