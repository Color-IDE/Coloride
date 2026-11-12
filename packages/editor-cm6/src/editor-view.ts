import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import {
  Annotation,
  EditorSelection as CmSelection,
  Compartment,
  EditorState,
} from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  CONTRACT_SCHEMA_VERSION,
  type EditorSnapshot,
  type EditorTransaction,
  type TextChange,
  type TransactionOrigin,
} from "@coloride/protocol-types";
import {
  decodeEditorSnapshotBinary,
  decodeEditorTransactionBinary,
  encodeEditorSnapshotBinary,
  encodeEditorTransactionBinary,
} from "./binary-ipc.js";
import {
  type EditorRangeDecoration,
  colorideStateDecorations,
  colorideStateField,
  setColorideDecorationsEffect,
  suppressLocalInvalidationAnnotation,
} from "./decorations.js";
import { createLezerHighlightingExtensions } from "./languages.js";
import {
  type Cm6TranslatedKeybinding,
  DEFAULT_COLORIDE_CM6_THEME,
  type DeclarativeVsixBundle,
  type DeclarativeVsixSnippet,
  type DeclarativeVsixTheme,
  KEYMAP_PRESET_BINDINGS,
  type KeymapPresetId,
  createKeymapCompartmentExtension,
  createKeymapExtension,
  createThemeCompartmentExtension,
  createThemeExtension,
  renderSnippetTemplate,
} from "./onboarding-vsix.js";

const documentSwitchAnnotation = Annotation.define<boolean>();
const transactionOriginAnnotation = Annotation.define<TransactionOrigin>();

export interface BinaryIpcChannel {
  openDocument(
    documentId: string,
    sessionGeneration: number,
    initialContent: string,
  ): void | Promise<void>;
  sendBinaryTransaction(payload: Uint8Array): void | Promise<void>;
  requestAtomicSave(documentId: string, sessionGeneration: number): Promise<Uint8Array>;
  onBinarySnapshot(listener: (payload: Uint8Array) => void): () => void;
}

function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `blake3-sim-${hash.toString(16).padStart(8, "0")}-${text.length}`;
}

interface HostBufferRecord {
  documentId: string;
  sessionGeneration: number;
  text: string;
  interactiveRevision: number;
  journaledRevision: number;
  diskSavedRevision: number;
  savedDiskText: string;
}

/**
 * Binary IPC Host Bridge implementing the exact `(document_id, session_generation)`
 * and revision semantics of `crates/host-core::DocumentService` over binary `Uint8Array` packets.
 * Supports configurable per-document IPC latency injection for race-condition testing.
 */
export class InMemoryBinaryHostBridge implements BinaryIpcChannel {
  private readonly buffers = new Map<string, HostBufferRecord>();
  private readonly latestGenByDoc = new Map<string, number>();
  private readonly artificialDelaysMs = new Map<string, number>();
  private readonly listeners = new Set<(payload: Uint8Array) => void>();

  setArtificialDelayMs(documentId: string, delayMs: number): void {
    this.artificialDelaysMs.set(documentId, delayMs);
  }

  private key(documentId: string, sessionGeneration: number): string {
    return `${documentId}::${sessionGeneration}`;
  }

  openDocument(documentId: string, sessionGeneration: number, initialContent: string): void {
    this.latestGenByDoc.set(documentId, sessionGeneration);
    this.buffers.set(this.key(documentId, sessionGeneration), {
      documentId,
      sessionGeneration,
      text: initialContent,
      interactiveRevision: 0,
      journaledRevision: 0,
      diskSavedRevision: 0,
      savedDiskText: initialContent,
    });
  }

  sendBinaryTransaction(payload: Uint8Array): void {
    const tx = decodeEditorTransactionBinary(payload);
    const latestGen = this.latestGenByDoc.get(tx.document_id);
    if (latestGen !== undefined && latestGen !== tx.session_generation) {
      return;
    }
    const record = this.buffers.get(this.key(tx.document_id, tx.session_generation));
    if (!record || tx.base_revision !== record.interactiveRevision) {
      return;
    }

    let nextText = record.text;
    for (const change of tx.changes) {
      const start = change.range_utf16.start;
      const end = change.range_utf16.end;
      nextText = nextText.slice(0, start) + change.inserted_text + nextText.slice(end);
    }

    record.text = nextText;
    record.interactiveRevision += 1;
    record.journaledRevision = record.interactiveRevision;

    const snapshot: EditorSnapshot = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      document_id: record.documentId,
      session_generation: record.sessionGeneration,
      interactive_revision: record.interactiveRevision,
      journaled_revision: record.journaledRevision,
      disk_saved_revision: record.diskSavedRevision,
      content_blake3_hash: fnv1aHex(record.text),
      has_unsaved_changes: record.interactiveRevision !== record.diskSavedRevision,
    };

    const binarySnap = encodeEditorSnapshotBinary(snapshot);
    const delayMs = this.artificialDelaysMs.get(tx.document_id) ?? 0;
    if (delayMs > 0) {
      setTimeout(() => {
        this.emitSnapshot(binarySnap);
      }, delayMs);
    } else {
      this.emitSnapshot(binarySnap);
    }
  }

  async requestAtomicSave(documentId: string, sessionGeneration: number): Promise<Uint8Array> {
    const record = this.buffers.get(this.key(documentId, sessionGeneration));
    if (!record) {
      throw new Error(`Host buffer not found for ${documentId}@${sessionGeneration}`);
    }
    const targetRev = record.interactiveRevision;
    const snapshotText = record.text;

    const delayMs = this.artificialDelaysMs.get(documentId) ?? 0;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    record.diskSavedRevision = Math.max(record.diskSavedRevision, targetRev);
    record.savedDiskText = snapshotText;

    const snapshot: EditorSnapshot = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      document_id: record.documentId,
      session_generation: record.sessionGeneration,
      interactive_revision: record.interactiveRevision,
      journaled_revision: record.journaledRevision,
      disk_saved_revision: record.diskSavedRevision,
      content_blake3_hash: fnv1aHex(record.text),
      has_unsaved_changes: record.interactiveRevision !== record.diskSavedRevision,
    };
    const encoded = encodeEditorSnapshotBinary(snapshot);
    this.emitSnapshot(encoded);
    return encoded;
  }

  onBinarySnapshot(listener: (payload: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getHostText(documentId: string, sessionGeneration: number): string | undefined {
    return this.buffers.get(this.key(documentId, sessionGeneration))?.text;
  }

  getSavedDiskText(documentId: string, sessionGeneration: number): string | undefined {
    return this.buffers.get(this.key(documentId, sessionGeneration))?.savedDiskText;
  }

  private emitSnapshot(payload: Uint8Array): void {
    for (const listener of this.listeners) {
      listener(payload);
    }
  }
}

export interface ColorideEditorStoreSnapshot {
  readonly documentId: string;
  readonly sessionGeneration: number;
  readonly revision: number;
  readonly imeComposing: boolean;
  readonly lastAckSnapshot: EditorSnapshot | null;
  readonly droppedStaleIpcPackets: number;
  readonly mountCount: number;
  readonly activeKeymapPreset: KeymapPresetId;
  readonly activeThemeLabel: string;
  readonly loadedVsixCount: number;
  readonly lastIpcError: string | null;
}

export interface ColorideEditorOptions {
  readonly initialDocumentId: string;
  readonly initialContent: string;
  readonly ipcChannel: BinaryIpcChannel;
  readonly initialDecorations?: readonly EditorRangeDecoration[];
  readonly initialKeymapPreset?: KeymapPresetId;
  readonly initialTheme?: DeclarativeVsixTheme;
}

/**
 * Imperatively mounted CodeMirror 6 Editor controller strictly isolated from React re-renders.
 * Never unmounts/remounts `EditorView` on state updates or tab switches (`mountCount === 1`).
 */
export class ColorideEditorView {
  private view: EditorView | null = null;
  private documentId: string;
  private sessionGeneration = 1;
  private localRevision = 0;
  private opSequence = 0;
  private imeComposing = false;
  private imeBasePos: number | null = null;
  private imePreviewLength = 0;
  private pendingSaveWaiters: Array<() => void> = [];
  private lastAckSnapshot: EditorSnapshot | null = null;
  private lastIpcError: string | null = null;
  private droppedStaleIpcPackets = 0;
  private mountCount = 0;
  private activeKeymapPreset: KeymapPresetId;
  private customKeybindings: Cm6TranslatedKeybinding[] = [];
  private activeTheme: DeclarativeVsixTheme;
  private registeredSnippets: DeclarativeVsixSnippet[] = [];
  private loadedVsixBundles: DeclarativeVsixBundle[] = [];
  private lastTriggeredKeyCommand: string | null = null;
  private readonly keymapCompartment = new Compartment();
  private readonly themeCompartment = new Compartment();
  private unsubscribeIpc: (() => void) | null = null;
  private readonly storeListeners = new Set<() => void>();
  private readonly ipcChannel: BinaryIpcChannel;

  constructor(options: ColorideEditorOptions) {
    this.documentId = options.initialDocumentId;
    this.ipcChannel = options.ipcChannel;
    this.activeKeymapPreset = options.initialKeymapPreset ?? "VsCode";
    this.activeTheme = options.initialTheme ?? DEFAULT_COLORIDE_CM6_THEME;
    this.trackIpcOperation(
      this.ipcChannel.openDocument(this.documentId, this.sessionGeneration, options.initialContent),
    );

    this.unsubscribeIpc = this.ipcChannel.onBinarySnapshot((payload) => {
      this.handleIncomingBinarySnapshot(payload);
    });

    const state = this.createEditorState(
      options.initialDocumentId,
      options.initialContent,
      options.initialDecorations ?? [],
    );
    this.view = new EditorView({ state });
  }

  /**
   * Mount the singleton `EditorView` into a DOM container once.
   * Subsequent calls with the same container are no-ops so React re-renders never remount CM6.
   */
  mount(container: HTMLElement): EditorView {
    if (!this.view) {
      throw new Error("ColorideEditorView has been destroyed");
    }
    if (this.view.dom.parentElement !== container) {
      container.appendChild(this.view.dom);
      this.mountCount += 1;
      this.notifyStoreListeners();
    }
    return this.view;
  }

  getEditorView(): EditorView {
    if (!this.view) {
      throw new Error("ColorideEditorView has been destroyed");
    }
    return this.view;
  }

  getDocumentText(): string {
    return this.getEditorView().state.doc.toString();
  }

  getDecorations(): readonly EditorRangeDecoration[] {
    return this.getEditorView().state.field(colorideStateField).ranges;
  }

  setValidationDecorations(decorations: readonly EditorRangeDecoration[]): void {
    const view = this.getEditorView();
    view.dispatch({
      effects: setColorideDecorationsEffect.of(decorations),
    });
  }

  /**
   * Switch to another file inside the existing `EditorView` instance without remounting DOM.
   * Increments `sessionGeneration` so any delayed IPC event from the previous file is dropped.
   */
  switchDocument(
    nextDocumentId: string,
    nextContent: string,
    decorations: readonly EditorRangeDecoration[] = [],
  ): void {
    const view = this.getEditorView();
    this.sessionGeneration += 1;
    this.documentId = nextDocumentId;
    this.localRevision = 0;
    this.imeComposing = false;
    this.imeBasePos = null;
    this.imePreviewLength = 0;
    this.lastAckSnapshot = null;

    this.trackIpcOperation(
      this.ipcChannel.openDocument(this.documentId, this.sessionGeneration, nextContent),
    );

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: nextContent },
      selection: CmSelection.cursor(0),
      effects: [
        setColorideDecorationsEffect.of(decorations),
        suppressLocalInvalidationAnnotation.of(true),
      ],
      annotations: documentSwitchAnnotation.of(true),
    });

    this.notifyStoreListeners();
  }

  /**
   * Dispatch a local user edit at UTF-16 offsets `[from, to)`.
   */
  dispatchUserEdit(
    from: number,
    to: number,
    insertedText: string,
    origin: TransactionOrigin = "User",
  ): void {
    const view = this.getEditorView();
    const nextCursor = from + insertedText.length;
    view.dispatch({
      changes: { from, to, insert: insertedText },
      selection: CmSelection.cursor(nextCursor),
      annotations: transactionOriginAnnotation.of(origin),
    });
  }

  /**
   * Begin an IME composition session (`compositionstart`).
   * While active, snapshot freezes and disk saves are deferred until `endImeComposition`.
   */
  startImeComposition(atPos?: number): void {
    const view = this.getEditorView();
    this.imeComposing = true;
    this.imeBasePos = atPos ?? view.state.selection.main.head;
    this.imePreviewLength = 0;
    this.notifyStoreListeners();
  }

  /**
   * Update the pre-edit IME composition text in the editor buffer without allowing premature save.
   */
  updateImeComposition(preeditText: string): void {
    if (!this.imeComposing) {
      this.startImeComposition();
    }
    const view = this.getEditorView();
    const from = this.imeBasePos ?? view.state.selection.main.head;
    const to = from + this.imePreviewLength;
    this.imePreviewLength = preeditText.length;
    view.dispatch({
      changes: { from, to, insert: preeditText },
      selection: CmSelection.cursor(from + preeditText.length),
      annotations: transactionOriginAnnotation.of("User"),
    });
  }

  /**
   * Complete the IME composition session (`compositionend`), committing the final composed string
   * and unblocking any deferred save/snapshot requests.
   */
  endImeComposition(finalCommittedText?: string): void {
    const view = this.getEditorView();
    if (finalCommittedText !== undefined) {
      const from = this.imeBasePos ?? view.state.selection.main.head;
      const to = from + this.imePreviewLength;
      this.imeComposing = false;
      this.imeBasePos = null;
      this.imePreviewLength = 0;
      view.dispatch({
        changes: { from, to, insert: finalCommittedText },
        selection: CmSelection.cursor(from + finalCommittedText.length),
        annotations: transactionOriginAnnotation.of("User"),
      });
    } else {
      this.imeComposing = false;
      this.imeBasePos = null;
      this.imePreviewLength = 0;
    }

    const waiters = this.pendingSaveWaiters.splice(0, this.pendingSaveWaiters.length);
    for (const resume of waiters) {
      resume();
    }
    this.notifyStoreListeners();
  }

  /**
   * Request an atomic disk save for the currently active `(documentId, sessionGeneration)`.
   * If an IME composition is active, waits until `compositionend` before flushing to disk.
   */
  async requestSave(): Promise<EditorSnapshot> {
    if (this.imeComposing) {
      await new Promise<void>((resolve) => {
        this.pendingSaveWaiters.push(resolve);
      });
    }
    const targetDocId = this.documentId;
    const targetGen = this.sessionGeneration;
    const binarySnap = await this.ipcChannel.requestAtomicSave(targetDocId, targetGen);
    const decoded = decodeEditorSnapshotBinary(binarySnap);
    if (
      decoded.document_id === this.documentId &&
      decoded.session_generation === this.sessionGeneration
    ) {
      this.lastAckSnapshot = decoded;
      this.notifyStoreListeners();
    }
    return decoded;
  }

  getStoreSnapshot(): ColorideEditorStoreSnapshot {
    return {
      documentId: this.documentId,
      sessionGeneration: this.sessionGeneration,
      revision: this.localRevision,
      imeComposing: this.imeComposing,
      lastAckSnapshot: this.lastAckSnapshot,
      droppedStaleIpcPackets: this.droppedStaleIpcPackets,
      mountCount: this.mountCount,
      activeKeymapPreset: this.activeKeymapPreset,
      activeThemeLabel: this.activeTheme.label,
      loadedVsixCount: this.loadedVsixBundles.length,
      lastIpcError: this.lastIpcError,
    };
  }

  /**
   * Switch active keymap preset (`VS Code`, `Vim`, `JetBrains`) in-place via CodeMirror 6 Compartment
   * without unmounting or remounting `EditorView` (`mountCount === 1`).
   */
  setKeymapPreset(
    preset: KeymapPresetId,
    customBindings?: readonly Cm6TranslatedKeybinding[],
  ): void {
    const view = this.getEditorView();
    this.activeKeymapPreset = preset;
    if (customBindings !== undefined) {
      this.customKeybindings = [...customBindings];
    }
    view.dispatch({
      effects: this.keymapCompartment.reconfigure(
        createKeymapExtension(this.activeKeymapPreset, this.customKeybindings, (cmd) => {
          this.lastTriggeredKeyCommand = cmd;
        }),
      ),
    });
    this.notifyStoreListeners();
  }

  getKeymapPreset(): KeymapPresetId {
    return this.activeKeymapPreset;
  }

  getActiveKeybindings(): readonly Cm6TranslatedKeybinding[] {
    return [...KEYMAP_PRESET_BINDINGS[this.activeKeymapPreset], ...this.customKeybindings];
  }

  getLastTriggeredKeyCommand(): string | null {
    return this.lastTriggeredKeyCommand;
  }

  /**
   * Apply a declarative `.vsix` theme in-place via CodeMirror 6 Compartment.
   */
  setTheme(theme: DeclarativeVsixTheme): void {
    const view = this.getEditorView();
    this.activeTheme = theme;
    view.dispatch({
      effects: this.themeCompartment.reconfigure(createThemeExtension(theme)),
    });
    this.notifyStoreListeners();
  }

  getActiveTheme(): DeclarativeVsixTheme {
    return this.activeTheme;
  }

  /**
   * Load a Tier-1 declarative `.vsix` bundle (`LOT-006`) into CodeMirror 6:
   * registers its themes, snippets, and keybindings while executing `0` imperative JS entrypoints.
   */
  applyDeclarativeVsixBundle(bundle: DeclarativeVsixBundle): void {
    this.loadedVsixBundles.push(bundle);
    if (bundle.snippets.length > 0) {
      this.registeredSnippets.push(...bundle.snippets);
    }
    if (bundle.keybindings.length > 0) {
      this.customKeybindings.push(...bundle.keybindings);
      this.setKeymapPreset(this.activeKeymapPreset);
    }
    const firstTheme = bundle.themes[0];
    if (firstTheme) {
      this.setTheme(firstTheme);
    } else {
      this.notifyStoreListeners();
    }
  }

  getRegisteredSnippets(): readonly DeclarativeVsixSnippet[] {
    return this.registeredSnippets;
  }

  /**
   * Expand a registered `.vsix` snippet by its prefix at the current cursor position.
   */
  expandSnippetByPrefix(prefix: string): boolean {
    const snippet = this.registeredSnippets.find((s) => s.prefix === prefix);
    if (!snippet) {
      return false;
    }
    const view = this.getEditorView();
    const head = view.state.selection.main.head;
    const expanded = renderSnippetTemplate(snippet.body);
    view.dispatch({
      changes: { from: head, to: head, insert: expanded.text },
      selection: CmSelection.cursor(head + expanded.cursorRelativeOffset),
      annotations: transactionOriginAnnotation.of("User"),
    });
    return true;
  }

  /**
   * 1-click reset to Coloride default theme, `VS Code` keymap preset, and clean custom bindings/snippets.
   */
  resetToColorideDefaults(): void {
    this.customKeybindings = [];
    this.registeredSnippets = [];
    this.loadedVsixBundles = [];
    this.setKeymapPreset("VsCode", []);
    this.setTheme(DEFAULT_COLORIDE_CM6_THEME);
  }

  subscribe(listener: () => void): () => void {
    this.storeListeners.add(listener);
    return () => {
      this.storeListeners.delete(listener);
    };
  }

  destroy(): void {
    if (this.unsubscribeIpc) {
      this.unsubscribeIpc();
      this.unsubscribeIpc = null;
    }
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    this.storeListeners.clear();
  }

  private createEditorState(
    documentId: string,
    initialContent: string,
    initialDecorations: readonly EditorRangeDecoration[],
  ): EditorState {
    const baseState = EditorState.create({
      doc: initialContent,
      extensions: [
        EditorState.tabSize.of(2),
        indentUnit.of("  "),
        ...colorideStateDecorations(),
        lineNumbers({
          formatNumber: (lineNo) => String(lineNo).padStart(4, " "),
        }),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        rectangularSelection(),
        closeBrackets(),
        highlightActiveLine(),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        ...createLezerHighlightingExtensions(documentId),
        createKeymapCompartmentExtension(
          this.keymapCompartment,
          this.activeKeymapPreset,
          this.customKeybindings,
          (cmd) => {
            this.lastTriggeredKeyCommand = cmd;
          },
        ),
        createThemeCompartmentExtension(this.themeCompartment, this.activeTheme),
        this.createHostDeltaSyncExtension(),
      ],
    });

    if (initialDecorations.length === 0) {
      return baseState;
    }

    return baseState.update({
      effects: setColorideDecorationsEffect.of(initialDecorations),
    }).state;
  }

  private createHostDeltaSyncExtension() {
    return [
      EditorView.domEventHandlers({
        compositionstart: () => {
          this.imeComposing = true;
          this.notifyStoreListeners();
          return false;
        },
        compositionend: () => {
          this.imeComposing = false;
          const waiters = this.pendingSaveWaiters.splice(0, this.pendingSaveWaiters.length);
          for (const resume of waiters) {
            resume();
          }
          this.notifyStoreListeners();
          return false;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) {
          return;
        }
        const isSwitch = update.transactions.some((tr) => tr.annotation(documentSwitchAnnotation));
        if (isSwitch) {
          return;
        }

        const changes: TextChange[] = [];
        update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          changes.push({
            range_utf16: { start: fromA, end: toA },
            range_utf8: null,
            inserted_text: inserted.toString(),
          });
        });

        if (changes.length === 0) {
          return;
        }

        const origin =
          update.transactions
            .map((tr) => tr.annotation(transactionOriginAnnotation))
            .find((o): o is TransactionOrigin => o !== undefined) ?? "User";

        const sel = update.state.selection.main;
        const headLine = update.state.doc.lineAt(sel.head);
        const baseRevision = this.localRevision;
        this.localRevision += 1;
        this.opSequence += 1;

        const tx: EditorTransaction = {
          schema_version: CONTRACT_SCHEMA_VERSION,
          document_id: this.documentId,
          session_generation: this.sessionGeneration,
          base_revision: baseRevision,
          op_id: `op-${this.sessionGeneration}-${this.opSequence}`,
          changes,
          selection: {
            anchor: sel.anchor,
            head: sel.head,
            cursor_line_col: {
              line: headLine.number - 1,
              col_utf16: sel.head - headLine.from,
            },
          },
          origin,
          ime_composing: this.imeComposing || update.view.composing,
        };

        const binaryPayload = encodeEditorTransactionBinary(tx);
        this.trackIpcOperation(this.ipcChannel.sendBinaryTransaction(binaryPayload));
        this.notifyStoreListeners();
      }),
    ];
  }

  private handleIncomingBinarySnapshot(payload: Uint8Array): void {
    const snapshot = decodeEditorSnapshotBinary(payload);
    // Strict (document_id, session_generation) guard:
    // Drop any delayed IPC event belonging to a previous file or stale generation.
    if (
      snapshot.document_id !== this.documentId ||
      snapshot.session_generation !== this.sessionGeneration
    ) {
      this.droppedStaleIpcPackets += 1;
      this.notifyStoreListeners();
      return;
    }

    this.lastAckSnapshot = snapshot;
    this.lastIpcError = null;
    this.notifyStoreListeners();
  }

  private trackIpcOperation(operation: void | Promise<void>): void {
    if (!operation) return;
    void operation.catch((error: unknown) => {
      this.lastIpcError = error instanceof Error ? error.message : "Editor IPC operation failed";
      this.notifyStoreListeners();
    });
  }

  private notifyStoreListeners(): void {
    for (const listener of this.storeListeners) {
      listener();
    }
  }
}
