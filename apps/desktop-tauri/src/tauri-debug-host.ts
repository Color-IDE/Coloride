import type { DebugEventMessage, DebugHost } from "@coloride/web-ui";
import type { RawChannel } from "./tauri-terminal-host.js";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * The debugger backed by the Rust side (`commands/debug.rs`). Events arrive on a binary Tauri
 * `Channel` as JSON frames, at most one every 16 ms.
 */
export function createTauriDebugHost(invoke: Invoke, createChannel: () => RawChannel): DebugHost {
  const decoder = new TextDecoder();
  return {
    async start(program, breakpoints, onEvents) {
      const channel = createChannel();
      channel.onmessage = (message) => {
        let frame: unknown;
        try {
          frame = JSON.parse(decoder.decode(message));
        } catch {
          return;
        }
        if (Array.isArray(frame)) onEvents(frame as DebugEventMessage[]);
      };
      await invoke("debug_start_command", {
        program,
        breakpoints: breakpoints.map(([path, lines]) => [path, [...lines]]),
        events: channel,
      });
    },
    request: (command) => invoke("debug_request_command", { command }),
    setBreakpoints: async (path, lines) => {
      await invoke("debug_set_breakpoints_command", { path, lines: [...lines] });
    },
    stop: () => invoke("debug_stop_command"),
  };
}
