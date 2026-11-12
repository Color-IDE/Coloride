import type { BinaryIpcChannel } from "@coloride/editor-cm6";
import { invoke } from "@tauri-apps/api/core";

function toUint8Array(value: number[] | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : Uint8Array.from(value);
}

export type TauriInvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class TauriBinaryHostBridge implements BinaryIpcChannel {
  private readonly listeners = new Set<(payload: Uint8Array) => void>();
  private documentReady: Promise<void> = Promise.resolve();
  private transactionQueue: Promise<void> = Promise.resolve();

  constructor(private readonly invokeCommand: TauriInvokeCommand = invoke) {}

  async openDocument(
    documentId: string,
    sessionGeneration: number,
    initialContent: string,
  ): Promise<void> {
    this.documentReady = this.invokeCommand<number[]>("open_document_binary_command", {
      documentId,
      sessionGeneration,
      initialText: initialContent,
    }).then(() => undefined);
    this.transactionQueue = this.documentReady.catch(() => undefined);
    await this.documentReady;
  }

  sendBinaryTransaction(payload: Uint8Array): Promise<void> {
    const request = this.transactionQueue.then(async () => {
      await this.documentReady;
      const response = await this.invokeCommand<number[]>("apply_binary_transaction_command", {
        payload: Array.from(payload),
      });
      this.emit(toUint8Array(response));
    });
    this.transactionQueue = request.catch(() => undefined);
    return request;
  }

  async waitForDocumentReady(): Promise<void> {
    await this.documentReady;
  }

  async requestAtomicSave(documentId: string, sessionGeneration: number): Promise<Uint8Array> {
    await this.documentReady;
    await this.transactionQueue;
    const response = await this.invokeCommand<number[]>("save_document_binary_command", {
      documentId,
      sessionGeneration,
    });
    const payload = toUint8Array(response);
    this.emit(payload);
    return payload;
  }

  onBinarySnapshot(listener: (payload: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(payload: Uint8Array): void {
    for (const listener of this.listeners) listener(payload);
  }
}
