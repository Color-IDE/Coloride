import { describe, expect, it } from "vitest";
import { createTauriDebugHost } from "./tauri-debug-host.js";
import type { RawChannel } from "./tauri-terminal-host.js";

describe("debugger over a Tauri channel", () => {
  it("starts with the breakpoints and decodes JSON event frames, ignoring malformed ones", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    let channel: RawChannel | null = null;
    const host = createTauriDebugHost(
      async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push([command, args]);
        return undefined as T;
      },
      () => {
        channel = { onmessage: () => undefined };
        return channel;
      },
    );
    const frames: unknown[] = [];
    await host.start("src/app.js", [["src/app.js", [3, 7]]], (events) => frames.push(events));
    expect(calls[0]).toEqual([
      "debug_start_command",
      { program: "src/app.js", breakpoints: [["src/app.js", [3, 7]]], events: channel },
    ]);
    const send = (text: string) =>
      (channel as unknown as RawChannel).onmessage(
        new TextEncoder().encode(text).buffer as ArrayBuffer,
      );
    send(JSON.stringify([{ role: "Debuggee", event: "stopped", body: { threadId: 1 } }]));
    send("not json");
    send(JSON.stringify({ not: "a frame" }));
    expect(frames).toEqual([[{ role: "Debuggee", event: "stopped", body: { threadId: 1 } }]]);

    await host.request({ Next: { thread_id: 1 } });
    await host.setBreakpoints("src/app.js", [4]);
    await host.stop();
    expect(calls.slice(1)).toEqual([
      ["debug_request_command", { command: { Next: { thread_id: 1 } } }],
      ["debug_set_breakpoints_command", { path: "src/app.js", lines: [4] }],
      ["debug_stop_command", undefined],
    ]);
  });
});
