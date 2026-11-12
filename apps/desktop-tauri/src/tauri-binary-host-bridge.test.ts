import { describe, expect, it } from "vitest";
import { TauriBinaryHostBridge, type TauriInvokeCommand } from "./tauri-binary-host-bridge.js";

describe("TauriBinaryHostBridge", () => {
  it("serializes rapid editor transactions in CodeMirror revision order", async () => {
    const calls: number[] = [];
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const invokeCommand: TauriInvokeCommand = async <T>(
      command: string,
      args: Record<string, unknown> = {},
    ) => {
      if (command === "open_document_binary_command") return [] as T;
      if (command === "apply_binary_transaction_command") {
        const payload = args.payload as number[];
        const marker = payload[0] ?? 0;
        calls.push(marker);
        if (marker === 1) {
          markFirstStarted?.();
          await firstBlocked;
        }
        return [marker] as T;
      }
      throw new Error(`Unexpected command ${command}`);
    };
    const bridge = new TauriBinaryHostBridge(invokeCommand);
    await bridge.openDocument("main.ts", 1, "");

    const first = bridge.sendBinaryTransaction(Uint8Array.of(1));
    const second = bridge.sendBinaryTransaction(Uint8Array.of(2));
    await firstStarted;
    expect(calls).toEqual([1]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(calls).toEqual([1, 2]);
  });
});
