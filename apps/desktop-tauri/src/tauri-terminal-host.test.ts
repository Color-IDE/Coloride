import { describe, expect, it } from "vitest";
import { type RawChannel, createTauriTerminalHost } from "./tauri-terminal-host.js";

describe("terminal over a Tauri channel", () => {
  it("opens with the size, streams raw frames, and reports an empty frame as the exit", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    let channel: RawChannel | null = null;
    const host = createTauriTerminalHost(
      async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push([command, args]);
        return (command === "terminal_open_command" ? 7 : undefined) as T;
      },
      () => {
        channel = { onmessage: () => undefined };
        return channel;
      },
    );
    const output: string[] = [];
    let exits = 0;
    const handle = await host.open(
      { cols: 90, rows: 20 },
      (bytes) => output.push(new TextDecoder().decode(bytes)),
      () => {
        exits += 1;
      },
    );
    expect(calls[0]).toEqual(["terminal_open_command", { cols: 90, rows: 20, output: channel }]);

    const send = (text: string) =>
      (channel as unknown as RawChannel).onmessage(
        new TextEncoder().encode(text).buffer as ArrayBuffer,
      );
    send("hello ");
    send("world");
    send("");
    send("");
    expect(output).toEqual(["hello ", "world"]);
    expect(exits).toBe(1);

    handle.write("ls\r");
    handle.resize(100, 40);
    handle.close();
    expect(calls.slice(1)).toEqual([
      ["terminal_write_command", { id: 7, data: "ls\r" }],
      ["terminal_resize_command", { id: 7, cols: 100, rows: 40 }],
      ["terminal_close_command", { id: 7 }],
    ]);
  });
});
