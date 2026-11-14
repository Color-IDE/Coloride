import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import { EditorView, type KeyBinding } from "@codemirror/view";
import type {
  LanguageFeature,
  LanguageFeatureRequest,
  LanguageFeatureResponse,
  LanguageFileEdits,
  LanguageLocation,
  LanguageTextEdit,
} from "@coloride/protocol-types";

/** Asks the host's language servers (`vtsls`, Biome) about one revision of the document. */
export type LanguageFeatureProvider = (
  request: LanguageFeatureRequest,
) => Promise<LanguageFeatureResponse>;

/** Called when "go to definition" leads to another file (the editor shows one file). */
export type NavigateToLocation = (location: LanguageLocation) => void;

/** What the feature client needs to know about the editor at a given moment. */
export interface LanguageFeatureEditorState {
  readonly documentId: string;
  readonly sessionGeneration: number;
  readonly revision: number;
}

export interface LanguageFeatureHost {
  current(): LanguageFeatureEditorState;
  view(): EditorView;
  /** Counts an answer dropped because the text moved on before it arrived. */
  discardStale(): void;
}

/**
 * Projects language server answers into CodeMirror 6 (`LOT-010`). Every request names the
 * revision it is about; an answer is used only if the editor is still at exactly that
 * revision when it arrives. Otherwise it is dropped: its offsets describe a text that no
 * longer exists, and edits applied there would corrupt the document.
 */
export class LanguageFeatureClient {
  private provider: LanguageFeatureProvider | null = null;
  private navigate: NavigateToLocation | null = null;

  constructor(private readonly host: LanguageFeatureHost) {}

  setProvider(provider: LanguageFeatureProvider | null, navigate?: NavigateToLocation): void {
    this.provider = provider;
    this.navigate = navigate ?? null;
  }

  hasProvider(): boolean {
    return this.provider !== null;
  }

  /** Sends a request about the current revision; null when the answer came too late. */
  async request(
    feature: LanguageFeature,
    position = this.host.view().state.selection.main.head,
  ): Promise<LanguageFeatureResponse | null> {
    if (!this.provider) return null;
    const asked = this.host.current();
    const response = await this.provider({
      document_id: asked.documentId,
      session_generation: asked.sessionGeneration,
      revision: asked.revision,
      position_utf16: position,
      feature,
    });
    const now = this.host.current();
    const current =
      response.document_id === now.documentId &&
      response.session_generation === now.sessionGeneration &&
      response.base_revision === now.revision &&
      response.base_revision === asked.revision;
    if (!current) {
      this.host.discardStale();
      return null;
    }
    return response;
  }

  /** Applies edits computed for the current revision as one transaction (one undo step). */
  private applyEdits(edits: readonly LanguageTextEdit[]): void {
    if (edits.length === 0) return;
    const view = this.host.view();
    view.dispatch({
      changes: edits.map((edit) => ({
        from: edit.span_utf16.start,
        to: edit.span_utf16.end,
        insert: edit.new_text,
      })),
      userEvent: "input.format",
    });
  }

  /** Formats the document; false when nothing was applied (no server, or a late answer). */
  async formatDocument(): Promise<boolean> {
    const response = await this.request("Formatting");
    if (!response || !("Edits" in response.result)) return false;
    this.applyEdits(response.result.Edits.edits);
    return true;
  }

  /**
   * Renames the symbol at the cursor in this document. The edits for other files are
   * returned for the caller to apply to those files; null when nothing was applied.
   */
  async renameSymbol(newName: string): Promise<readonly LanguageFileEdits[] | null> {
    const response = await this.request({ Rename: { new_name: newName } });
    if (!response || !("Rename" in response.result)) return null;
    this.applyEdits(response.result.Rename.edits);
    return response.result.Rename.other_files;
  }

  /** Locations of the definition or references of the symbol at the cursor. */
  async locations(feature: "Definition" | "References"): Promise<readonly LanguageLocation[]> {
    const response = await this.request(feature);
    if (!response || !("Locations" in response.result)) return [];
    return response.result.Locations.locations;
  }

  /** Moves to the definition: in this file directly, in another one through `navigate`. */
  async goToDefinition(): Promise<LanguageLocation | null> {
    const [target] = await this.locations("Definition");
    if (!target) return null;
    if (target.span_utf16) {
      const view = this.host.view();
      view.dispatch({
        selection: EditorSelection.range(target.span_utf16.start, target.span_utf16.end),
        effects: EditorView.scrollIntoView(target.span_utf16.start, { y: "center" }),
      });
      view.focus();
    } else {
      this.navigate?.(target);
    }
    return target;
  }

  /** CodeMirror completion source backed by the language server. */
  readonly completionSource: CompletionSource = async (
    context: CompletionContext,
  ): Promise<CompletionResult | null> => {
    if (!this.provider) return null;
    const word = context.matchBefore(/[\w$]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    // Asked about the text CodeMirror completes, which must also be the host's revision.
    if (context.state.doc !== this.host.view().state.doc) return null;
    const response = await this.request("Completion", context.pos).catch(() => null);
    if (!response || context.aborted || !("Completions" in response.result)) return null;
    const { items, is_incomplete } = response.result.Completions;
    const options: Completion[] = items.map((item) => ({
      label: item.label,
      type: item.kind,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.insert_text !== item.label ? { apply: item.insert_text } : {}),
      // The server orders by `sort_text`: keep that order ahead of CodeMirror's fuzzy score.
      boost: 0,
    }));
    const order = new Map(items.map((item, index) => [item.label, index]));
    options.sort((a, b) => (order.get(a.label) ?? 0) - (order.get(b.label) ?? 0));
    return {
      from: word.from,
      options,
      ...(is_incomplete ? {} : { validFor: /^[\w$]*$/ }),
    };
  };

  /** F12: go to definition. Shift+Alt+F: format document. */
  keyBindings(): KeyBinding[] {
    const run = (action: () => Promise<unknown>) => () => {
      if (!this.provider) return false;
      void action().catch(() => undefined);
      return true;
    };
    return [
      { key: "F12", run: run(() => this.goToDefinition()) },
      { key: "Shift-Alt-f", run: run(() => this.formatDocument()) },
    ];
  }
}
