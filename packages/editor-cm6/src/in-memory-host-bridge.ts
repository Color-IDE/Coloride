import { CONTRACT_SCHEMA_VERSION, type EditorSnapshot } from "@coloride/protocol-types";
import {
  type BinaryIpcChannel,
  decodeEditorTransactionBinary,
  encodeEditorSnapshotBinary,
} from "./binary-ipc.js";

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
