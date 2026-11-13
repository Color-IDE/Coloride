import {
  CONTRACT_SCHEMA_VERSION,
  type ColorideValidationState,
  type EditorSelection,
  type EditorSnapshot,
  type EditorTransaction,
  type LineCol,
  type TextChange,
  type TransactionOrigin,
} from "@coloride/protocol-types";

const MAGIC_TX = 0x434c5458; // "CLTX"
const MAGIC_SNAP = 0x434c534e; // "CLSN"

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class BinaryWriter {
  private buffer: Uint8Array;
  private view: DataView;
  private offset = 0;

  constructor(initialCapacity = 512) {
    this.buffer = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buffer.buffer);
  }

  private ensureCapacity(extraBytes: number): void {
    const required = this.offset + extraBytes;
    if (required <= this.buffer.byteLength) {
      return;
    }
    let nextCapacity = this.buffer.byteLength * 2;
    while (nextCapacity < required) {
      nextCapacity *= 2;
    }
    const nextBuffer = new Uint8Array(nextCapacity);
    nextBuffer.set(this.buffer.subarray(0, this.offset));
    this.buffer = nextBuffer;
    this.view = new DataView(this.buffer.buffer);
  }

  writeU8(value: number): void {
    this.ensureCapacity(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  writeU16(value: number): void {
    this.ensureCapacity(2);
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  writeU32(value: number): void {
    this.ensureCapacity(4);
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
  }

  writeBool(value: boolean): void {
    this.writeU8(value ? 1 : 0);
  }

  writeString(value: string): void {
    const bytes = textEncoder.encode(value);
    this.writeU32(bytes.byteLength);
    this.ensureCapacity(bytes.byteLength);
    this.buffer.set(bytes, this.offset);
    this.offset += bytes.byteLength;
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.offset);
  }
}

class BinaryReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  readU8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  readU16(): number {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readU32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readBool(): boolean {
    return this.readU8() !== 0;
  }

  readString(): string {
    const len = this.readU32();
    const slice = this.bytes.subarray(this.offset, this.offset + len);
    this.offset += len;
    return textDecoder.decode(slice);
  }
}

function writeOrigin(writer: BinaryWriter, origin: TransactionOrigin): void {
  if (origin === "User") {
    writer.writeU8(0);
  } else if ("Agent" in origin) {
    writer.writeU8(1);
    writer.writeString(origin.Agent.task_id);
  } else if ("Peer" in origin) {
    writer.writeU8(2);
    writer.writeString(origin.Peer.peer_id);
  } else {
    writer.writeU8(3);
    writer.writeString(origin.Extension.extension_id);
  }
}

function readOrigin(reader: BinaryReader): TransactionOrigin {
  const tag = reader.readU8();
  switch (tag) {
    case 0:
      return "User";
    case 1:
      return { Agent: { task_id: reader.readString() } };
    case 2:
      return { Peer: { peer_id: reader.readString() } };
    case 3:
      return { Extension: { extension_id: reader.readString() } };
    default:
      throw new Error(`Invalid TransactionOrigin binary tag: ${tag}`);
  }
}

/**
 * Serialize an `EditorTransaction` into a compact binary payload (`Uint8Array`)
 * for zero-JSON-overhead transmission over `tauri::ipc::Channel`.
 */
export function encodeEditorTransactionBinary(tx: EditorTransaction): Uint8Array {
  const writer = new BinaryWriter(256);
  writer.writeU32(MAGIC_TX);
  writer.writeU16(tx.schema_version);
  writer.writeString(tx.document_id);
  writer.writeU32(tx.session_generation);
  writer.writeU32(tx.base_revision);
  writer.writeString(tx.op_id);

  writer.writeU32(tx.changes.length);
  for (const change of tx.changes) {
    writer.writeU32(change.range_utf16.start);
    writer.writeU32(change.range_utf16.end);
    if (change.range_utf8 !== null) {
      writer.writeBool(true);
      writer.writeU32(change.range_utf8.start);
      writer.writeU32(change.range_utf8.end);
    } else {
      writer.writeBool(false);
    }
    writer.writeString(change.inserted_text);
  }

  writer.writeU32(tx.selection.anchor);
  writer.writeU32(tx.selection.head);
  if (tx.selection.cursor_line_col !== null) {
    writer.writeBool(true);
    writer.writeU32(tx.selection.cursor_line_col.line);
    writer.writeU32(tx.selection.cursor_line_col.col_utf16);
  } else {
    writer.writeBool(false);
  }

  writeOrigin(writer, tx.origin);
  writer.writeBool(tx.ime_composing);
  return writer.finish();
}

/**
 * Deserialize an `EditorTransaction` from a binary `Uint8Array` payload.
 */
export function decodeEditorTransactionBinary(bytes: Uint8Array): EditorTransaction {
  const reader = new BinaryReader(bytes);
  const magic = reader.readU32();
  if (magic !== MAGIC_TX) {
    throw new Error(`Invalid EditorTransaction binary magic: 0x${magic.toString(16)}`);
  }
  const schemaVersion = reader.readU16();
  if (schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    throw new Error(`Unsupported EditorTransaction schema version: ${schemaVersion}`);
  }
  const documentId = reader.readString();
  const sessionGeneration = reader.readU32();
  const baseRevision = reader.readU32();
  const opId = reader.readString();

  const changesCount = reader.readU32();
  const changes: TextChange[] = [];
  for (let i = 0; i < changesCount; i += 1) {
    const startUtf16 = reader.readU32();
    const endUtf16 = reader.readU32();
    const hasUtf8 = reader.readBool();
    const rangeUtf8 = hasUtf8 ? { start: reader.readU32(), end: reader.readU32() } : null;
    const insertedText = reader.readString();
    changes.push({
      range_utf16: { start: startUtf16, end: endUtf16 },
      range_utf8: rangeUtf8,
      inserted_text: insertedText,
    });
  }

  const anchor = reader.readU32();
  const head = reader.readU32();
  const hasLineCol = reader.readBool();
  const cursorLineCol: LineCol | null = hasLineCol
    ? { line: reader.readU32(), col_utf16: reader.readU32() }
    : null;
  const selection: EditorSelection = {
    anchor,
    head,
    cursor_line_col: cursorLineCol,
  };

  const origin = readOrigin(reader);
  const imeComposing = reader.readBool();

  return {
    schema_version: schemaVersion,
    document_id: documentId,
    session_generation: sessionGeneration,
    base_revision: baseRevision,
    op_id: opId,
    changes,
    selection,
    origin,
    ime_composing: imeComposing,
  };
}

/**
 * Serialize an `EditorSnapshot` into a compact binary payload (`Uint8Array`).
 */
export function encodeEditorSnapshotBinary(snapshot: EditorSnapshot): Uint8Array {
  const writer = new BinaryWriter(128);
  writer.writeU32(MAGIC_SNAP);
  writer.writeU16(snapshot.schema_version);
  writer.writeString(snapshot.document_id);
  writer.writeU32(snapshot.session_generation);
  writer.writeU32(snapshot.interactive_revision);
  writer.writeU32(snapshot.journaled_revision);
  writer.writeU32(snapshot.disk_saved_revision);
  writer.writeString(snapshot.content_blake3_hash);
  writer.writeBool(snapshot.has_unsaved_changes);
  return writer.finish();
}

/**
 * Deserialize an `EditorSnapshot` from a binary `Uint8Array` payload.
 */
export function decodeEditorSnapshotBinary(bytes: Uint8Array): EditorSnapshot {
  const reader = new BinaryReader(bytes);
  const magic = reader.readU32();
  if (magic !== MAGIC_SNAP) {
    throw new Error(`Invalid EditorSnapshot binary magic: 0x${magic.toString(16)}`);
  }
  const schemaVersion = reader.readU16();
  if (schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    throw new Error(`Unsupported EditorSnapshot schema version: ${schemaVersion}`);
  }
  const documentId = reader.readString();
  const sessionGeneration = reader.readU32();
  const interactiveRevision = reader.readU32();
  const journaledRevision = reader.readU32();
  const diskSavedRevision = reader.readU32();
  const contentBlake3Hash = reader.readString();
  const hasUnsavedChanges = reader.readBool();

  return {
    schema_version: schemaVersion,
    document_id: documentId,
    session_generation: sessionGeneration,
    interactive_revision: interactiveRevision,
    journaled_revision: journaledRevision,
    disk_saved_revision: diskSavedRevision,
    content_blake3_hash: contentBlake3Hash,
    has_unsaved_changes: hasUnsavedChanges,
  };
}

export interface HostDecorationsPushMessage {
  readonly documentId: string;
  readonly sessionGeneration: number;
  readonly snapshot: EditorSnapshot;
  readonly decorations: readonly {
    readonly fromLine: number;
    readonly toLine: number;
    readonly state: ColorideValidationState;
    readonly snapshotHash: string;
  }[];
}

/** Transport between the CodeMirror view and the Rust host (`host-core::DocumentService`). */
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
