import {
  type ChangeDesc,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import type {
  DiagnosticSeverity,
  DiagnosticSource,
  DocumentDiagnostics,
} from "@coloride/protocol-types";

/** A diagnostic placed in the text the editor currently shows (UTF-16 offsets). */
export interface EditorDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly source: DiagnosticSource;
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
}

export type DiagnosticsRejection =
  /** Computed for another file or an earlier opening of this one. */
  | "stale-session"
  /** Computed for a revision the editor never had, or one too old to map from. */
  | "unknown-revision";

export interface DiagnosticsApplyResult {
  /** Diagnostics now shown, at offsets valid for the current text. */
  readonly applied: number;
  /** Diagnostics dropped because their line was edited after `base_revision`. */
  readonly discarded: number;
  /** Set when the whole batch was refused; nothing was changed then. */
  readonly rejected?: DiagnosticsRejection;
}

/** How many past revisions a late batch can still be mapped from. */
const MAX_TRACKED_REVISIONS = 512;

/**
 * What the editor remembers about its recent revisions: the text of each one and the change
 * that led to the next. This is what lets a late batch be placed correctly, or refused.
 */
export class RevisionHistory {
  /** `steps.get(r)`: the text of revision `r` and the change that produced `r + 1`. */
  private readonly steps = new Map<number, { readonly doc: Text; readonly change: ChangeDesc }>();

  /** Records that `change`, applied to `doc` (revision `revision`), produced `revision + 1`. */
  record(revision: number, doc: Text, change: ChangeDesc): void {
    this.steps.set(revision, { doc, change });
    this.steps.delete(revision - MAX_TRACKED_REVISIONS);
  }

  clear(): void {
    this.steps.clear();
  }

  /**
   * Brings diagnostics computed for `baseRevision` to `currentRevision`.
   *
   * A diagnostic is dropped as soon as an edit touches any line its range spans: the code it
   * described has changed, so it is neither moved nor shown. The others are shifted by exactly
   * the edits made around them. Returns null when the path from `baseRevision` is not known:
   * the batch then cannot be trusted at all.
   */
  rebase(
    items: readonly EditorDiagnostic[],
    baseRevision: number,
    currentRevision: number,
  ): { readonly kept: EditorDiagnostic[]; readonly discarded: number } | null {
    if (baseRevision > currentRevision) return null;
    if (baseRevision === currentRevision) return { kept: [...items], discarded: 0 };
    const first = this.steps.get(baseRevision);
    if (!first) return null;

    // Each diagnostic guards the whole lines it spans, as they were at `baseRevision`.
    let live = items.map((item) => {
      const from = clamp(item.from, first.doc.length);
      const to = clamp(Math.max(item.to, item.from), first.doc.length);
      return {
        item,
        from,
        to,
        guardFrom: first.doc.lineAt(from).from,
        guardTo: first.doc.lineAt(to).to,
      };
    });
    const total = live.length;

    for (let revision = baseRevision; revision < currentRevision; revision += 1) {
      const step = this.steps.get(revision);
      if (!step) return null;
      const { change } = step;
      live = live
        .filter((entry) => !change.touchesRange(entry.guardFrom, entry.guardTo))
        .map((entry) => ({
          item: entry.item,
          from: change.mapPos(entry.from, 1),
          to: change.mapPos(entry.to, -1),
          guardFrom: change.mapPos(entry.guardFrom, 1),
          guardTo: change.mapPos(entry.guardTo, -1),
        }));
    }
    return {
      kept: live.map((entry) => ({ ...entry.item, from: entry.from, to: entry.to })),
      discarded: total - live.length,
    };
  }
}

function clamp(position: number, length: number): number {
  return Math.max(0, Math.min(position, length));
}

/** Turns a host batch into editor diagnostics, still at the offsets of its own revision. */
export function diagnosticsFromBatch(batch: DocumentDiagnostics): EditorDiagnostic[] {
  return batch.items.map((item) => ({
    from: item.span_utf16.start,
    to: item.span_utf16.end,
    source: item.source,
    severity: item.severity,
    code: item.code,
    message: item.message,
  }));
}

/** Replaces every diagnostic of one source (a batch is that source's full, current list). */
export const setSourceDiagnosticsEffect = StateEffect.define<{
  readonly source: DiagnosticSource;
  readonly diagnostics: readonly EditorDiagnostic[];
}>();

/** Drops all diagnostics (the editor switched to another document). */
export const clearDiagnosticsEffect = StateEffect.define<null>();

interface DiagnosticsState {
  readonly diagnostics: readonly EditorDiagnostic[];
  readonly decorations: DecorationSet;
}

const SEVERITY_CLASS: Record<DiagnosticSeverity, string> = {
  Error: "cm-coloride-diagnostic-error",
  Warning: "cm-coloride-diagnostic-warning",
  Information: "cm-coloride-diagnostic-info",
};

function buildDecorations(doc: Text, diagnostics: readonly EditorDiagnostic[]): DecorationSet {
  const marks = diagnostics
    .map((diagnostic) => {
      const from = clamp(diagnostic.from, doc.length);
      let to = clamp(diagnostic.to, doc.length);
      // A mark needs at least one character: widen an empty range within its line.
      if (to <= from) to = Math.min(from + 1, doc.lineAt(from).to);
      return { diagnostic, from, to };
    })
    .filter((mark) => mark.to > mark.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const { diagnostic, from, to } of marks) {
    builder.add(
      from,
      to,
      Decoration.mark({
        class: `cm-coloride-diagnostic ${SEVERITY_CLASS[diagnostic.severity]}`,
        attributes: {
          title: `${diagnostic.message}${diagnostic.code ? ` (${diagnostic.source} ${diagnostic.code})` : ""}`,
        },
      }),
    );
  }
  return builder.finish();
}

/**
 * Diagnostics shown in the editor. Once shown they follow the text; one whose lines are edited
 * disappears at once, in the same transaction, instead of pointing at code it no longer
 * describes. The tool's next batch brings it back if it still applies.
 */
export const diagnosticsField = StateField.define<DiagnosticsState>({
  create: () => ({ diagnostics: [], decorations: Decoration.none }),
  update(value, tr) {
    let diagnostics = value.diagnostics;
    if (tr.docChanged && diagnostics.length > 0) {
      const before = tr.startState.doc;
      diagnostics = diagnostics
        .filter((diagnostic) => {
          const from = clamp(diagnostic.from, before.length);
          const to = clamp(Math.max(diagnostic.to, diagnostic.from), before.length);
          return !tr.changes.touchesRange(before.lineAt(from).from, before.lineAt(to).to);
        })
        .map((diagnostic) => ({
          ...diagnostic,
          from: tr.changes.mapPos(diagnostic.from, 1),
          to: tr.changes.mapPos(diagnostic.to, -1),
        }));
    }
    let replaced = false;
    for (const effect of tr.effects) {
      if (effect.is(clearDiagnosticsEffect)) {
        diagnostics = [];
        replaced = true;
      } else if (effect.is(setSourceDiagnosticsEffect)) {
        diagnostics = [
          ...diagnostics.filter((diagnostic) => diagnostic.source !== effect.value.source),
          ...effect.value.diagnostics,
        ];
        replaced = true;
      }
    }
    if (diagnostics === value.diagnostics && !replaced) return value;
    return { diagnostics, decorations: buildDecorations(tr.state.doc, diagnostics) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

const diagnosticsTheme = EditorView.baseTheme({
  ".cm-coloride-diagnostic": {
    textDecorationLine: "underline",
    textDecorationStyle: "wavy",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
  },
  ".cm-coloride-diagnostic-error": { textDecorationColor: "#f14c4c" },
  ".cm-coloride-diagnostic-warning": { textDecorationColor: "#cca700" },
  ".cm-coloride-diagnostic-info": { textDecorationColor: "#3794ff" },
});

export function colorideDiagnostics(): Extension {
  return [diagnosticsField, diagnosticsTheme];
}
