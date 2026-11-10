import {
  ColorideEditorView,
  type EditorRangeDecoration,
  InMemoryBinaryHostBridge,
} from "@coloride/editor-cm6";
import { createInitialCockpitShellState } from "@coloride/web-ui";

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
