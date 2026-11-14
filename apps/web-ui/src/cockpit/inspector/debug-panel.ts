import { UI_STRINGS } from "../../ui/ui-strings.js";

/** One DAP event as the host forwards it (the body is untrusted adapter data). */
export interface DebugEventMessage {
  readonly role: "Launcher" | "Debuggee";
  readonly event: string;
  readonly body: unknown;
}

/** Reads untrusted adapter JSON without trusting its shape. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

/** The requests the host accepts (`host_core::DebugCommand`). */
export type DebugCommandMessage =
  | { readonly Continue: { readonly thread_id: number } }
  | { readonly Next: { readonly thread_id: number } }
  | { readonly StepIn: { readonly thread_id: number } }
  | { readonly StepOut: { readonly thread_id: number } }
  | { readonly Pause: { readonly thread_id: number } }
  | "Threads"
  | { readonly StackTrace: { readonly thread_id: number } }
  | { readonly Scopes: { readonly frame_id: number } }
  | { readonly Variables: { readonly variables_reference: number } }
  | { readonly Evaluate: { readonly expression: string; readonly frame_id: number | null } };

export interface DebugHost {
  /** Starts `program` (a workspace path) with these breakpoints; events arrive in frames. */
  start(
    program: string,
    breakpoints: ReadonlyArray<readonly [string, readonly number[]]>,
    onEvents: (events: readonly DebugEventMessage[]) => void,
  ): Promise<void>;
  request(command: DebugCommandMessage): Promise<unknown>;
  setBreakpoints(path: string, lines: readonly number[]): Promise<void>;
  stop(): Promise<void>;
}

export interface DebugPanelContext {
  /** The file shown in the editor, if any (a workspace path). */
  currentFile(): string | null;
  /** Every breakpoint of the project, by workspace path. */
  breakpoints(): ReadonlyMap<string, readonly number[]>;
  /** Root of the project, to show workspace paths in the call stack. */
  projectPath(): string;
}

type DebugStatus = "idle" | "starting" | "running" | "paused" | "ended";

const MAX_OUTPUT_LINES = 2_000;

interface Row {
  readonly text: string;
  readonly title?: string;
}

/**
 * Debugging the current JavaScript file (`LOT-010`): controls, call stack, the paused frame's
 * variables, and the program's output. Lives in the sidebar's Debug section.
 */
export class DebugPanel {
  readonly element: HTMLElement;
  private readonly status: HTMLElement;
  private readonly stack: HTMLElement;
  private readonly variables: HTMLElement;
  private readonly output: HTMLElement;
  private readonly buttons: Record<
    "start" | "continue" | "next" | "stepIn" | "stepOut" | "stop",
    HTMLButtonElement
  >;
  private state: DebugStatus = "idle";
  private threadId: number | null = null;
  private outputLines: string[] = [];
  /** Bumped on every start/stop: events of an earlier session are ignored. */
  private generation = 0;

  constructor(
    doc: Document,
    private readonly host: DebugHost,
    private readonly context: DebugPanelContext,
  ) {
    this.element = doc.createElement("section");
    this.element.className = "coloride-debug-panel";
    this.element.setAttribute("aria-label", UI_STRINGS.debugger.panel);

    const toolbar = doc.createElement("div");
    toolbar.className = "coloride-debug-toolbar";
    const button = (label: string, action: () => void) => {
      const element = doc.createElement("button");
      element.type = "button";
      element.textContent = label;
      element.addEventListener("click", action);
      toolbar.append(element);
      return element;
    };
    this.buttons = {
      start: button(UI_STRINGS.debugger.start, () => void this.start()),
      continue: button(UI_STRINGS.debugger.continue, () => void this.step("Continue")),
      next: button(UI_STRINGS.debugger.stepOver, () => void this.step("Next")),
      stepIn: button(UI_STRINGS.debugger.stepInto, () => void this.step("StepIn")),
      stepOut: button(UI_STRINGS.debugger.stepOut, () => void this.step("StepOut")),
      stop: button(UI_STRINGS.debugger.stop, () => void this.stop()),
    };

    this.status = doc.createElement("div");
    this.status.className = "coloride-debug-status";
    this.status.setAttribute("role", "status");
    const heading = (text: string) => {
      const element = doc.createElement("h4");
      element.textContent = text;
      return element;
    };
    this.stack = doc.createElement("div");
    this.stack.className = "coloride-debug-stack";
    this.stack.setAttribute("role", "list");
    this.variables = doc.createElement("div");
    this.variables.className = "coloride-debug-variables";
    this.variables.setAttribute("role", "list");
    this.output = doc.createElement("pre");
    this.output.className = "coloride-debug-output";
    this.element.append(
      toolbar,
      this.status,
      heading(UI_STRINGS.debugger.callStack),
      this.stack,
      heading(UI_STRINGS.debugger.variables),
      this.variables,
      heading(UI_STRINGS.debugger.output),
      this.output,
    );
    this.render();
  }

  getStatus(): DebugStatus {
    return this.state;
  }

  /** F5 starts or continues, Shift+F5 stops, F10/F11/Shift+F11 step. True when handled. */
  handleKey(event: KeyboardEvent): boolean {
    const key = `${event.shiftKey ? "Shift+" : ""}${event.key}`;
    const actions: Record<string, () => unknown> = {
      F5: () => (this.state === "paused" ? this.step("Continue") : this.start()),
      "Shift+F5": () => this.stop(),
      F10: () => this.step("Next"),
      F11: () => this.step("StepIn"),
      "Shift+F11": () => this.step("StepOut"),
    };
    const action = actions[key];
    if (!action) return false;
    if (key !== "F5" && key !== "Shift+F5" && this.state !== "paused") return false;
    if (key === "Shift+F5" && (this.state === "idle" || this.state === "ended")) return false;
    void action();
    return true;
  }

  async start(): Promise<void> {
    const program = this.context.currentFile();
    if (!program) {
      this.setStatus("idle", UI_STRINGS.debugger.noFile);
      return;
    }
    if (this.state === "running" || this.state === "paused" || this.state === "starting") {
      await this.stop();
    }
    const generation = ++this.generation;
    this.outputLines = [];
    this.threadId = null;
    this.setStatus("starting", UI_STRINGS.debugger.starting(program));
    try {
      await this.host.start(program, [...this.context.breakpoints()], (events) => {
        if (generation === this.generation) this.onEvents(events);
      });
      if (generation === this.generation && this.state === "starting") {
        this.setStatus("running", UI_STRINGS.debugger.running);
      }
    } catch (error: unknown) {
      if (generation === this.generation) {
        this.setStatus("ended", error instanceof Error ? error.message : String(error));
      }
    }
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.threadId = null;
    this.setStatus("ended", UI_STRINGS.debugger.stopped);
    await this.host.stop().catch(() => undefined);
  }

  /** The editor's breakpoints of `path` changed: tell a running program. */
  breakpointsChanged(path: string, lines: readonly number[]): void {
    if (this.state === "running" || this.state === "paused" || this.state === "starting") {
      void this.host.setBreakpoints(path, lines).catch(() => undefined);
    }
  }

  private async step(kind: "Continue" | "Next" | "StepIn" | "StepOut"): Promise<void> {
    if (this.state !== "paused" || this.threadId === null) return;
    const thread_id = this.threadId;
    const command = { [kind]: { thread_id } } as DebugCommandMessage;
    await this.host.request(command).catch((error: unknown) => {
      this.setStatus(this.state, error instanceof Error ? error.message : String(error));
    });
  }

  private onEvents(events: readonly DebugEventMessage[]): void {
    for (const { role, event, body } of events) {
      const output = field(body, "output");
      if (event === "output" && typeof output === "string") {
        // The adapter's own telemetry is not program output.
        if (field(body, "category") === "telemetry") continue;
        this.appendOutput(output);
      } else if (event === "launchFailed") {
        this.setStatus("ended", text(field(body, "message"), UI_STRINGS.debugger.failed));
      } else if (role === "Debuggee" && event === "stopped") {
        this.threadId = int(field(body, "threadId")) ?? this.threadId;
        this.setStatus("paused", UI_STRINGS.debugger.paused(text(field(body, "reason"))));
        void this.refreshPausedState(this.generation);
      } else if (role === "Debuggee" && event === "continued") {
        this.setStatus("running", UI_STRINGS.debugger.running);
        this.showRows(this.stack, []);
        this.showRows(this.variables, []);
      } else if (event === "terminated" && this.state !== "ended") {
        this.setStatus("ended", UI_STRINGS.debugger.ended);
        this.showRows(this.stack, []);
        this.showRows(this.variables, []);
      } else if (role === "Debuggee" && event === "thread" && field(body, "reason") === "started") {
        this.threadId ??= int(field(body, "threadId"));
      }
    }
    this.render();
  }

  private async refreshPausedState(generation: number): Promise<void> {
    if (this.threadId === null) return;
    const current = () => generation === this.generation && this.state === "paused";
    try {
      const stack = await this.host.request({ StackTrace: { thread_id: this.threadId } });
      if (!current()) return;
      const frames = list(field(stack, "stackFrames"));
      this.showRows(
        this.stack,
        frames.map((frame) => ({
          text: `${text(field(frame, "name"), "?")}  ${this.location(frame)}`,
          title: text(field(field(frame, "source"), "path")),
        })),
      );
      const frameId = int(field(frames[0], "id"));
      if (frameId === null) return;
      const scopes = await this.host.request({ Scopes: { frame_id: frameId } });
      const scope = list(field(scopes, "scopes")).find(
        (candidate) => field(candidate, "expensive") !== true,
      );
      const reference = int(field(scope, "variablesReference"));
      if (reference === null || !current()) return;
      const variables = await this.host.request({
        Variables: { variables_reference: reference },
      });
      if (!current()) return;
      this.showRows(
        this.variables,
        list(field(variables, "variables")).map((variable) => ({
          text: `${text(field(variable, "name"), "?")} = ${text(field(variable, "value"))}`,
        })),
      );
    } catch {
      // The program moved on (or ended) while we were asking.
    }
  }

  private location(frame: unknown): string {
    const source = field(frame, "source");
    const path = text(field(source, "path"), text(field(source, "name")));
    const root = this.context.projectPath();
    const shown =
      root && path.startsWith(`${root}/`)
        ? path.slice(root.length + 1)
        : (path.split("/").pop() ?? path);
    return `${shown}:${text(field(frame, "line"), "?")}`;
  }

  private appendOutput(chunk: string): void {
    this.outputLines.push(...chunk.replace(/\n$/, "").split("\n"));
    if (this.outputLines.length > MAX_OUTPUT_LINES) {
      this.outputLines = this.outputLines.slice(-MAX_OUTPUT_LINES);
    }
    this.output.textContent = this.outputLines.join("\n");
    this.output.scrollTop = this.output.scrollHeight;
  }

  private showRows(list: HTMLElement, rows: readonly Row[]): void {
    const doc = list.ownerDocument;
    list.replaceChildren(
      ...rows.map((row) => {
        const element = doc.createElement("div");
        element.setAttribute("role", "listitem");
        element.textContent = row.text;
        if (row.title) element.title = row.title;
        return element;
      }),
    );
  }

  private setStatus(state: DebugStatus, text: string): void {
    this.state = state;
    this.status.textContent = text;
    this.render();
  }

  private render(): void {
    const paused = this.state === "paused";
    const active = this.state === "running" || paused || this.state === "starting";
    this.element.dataset.debugState = this.state;
    this.buttons.continue.disabled = !paused;
    this.buttons.next.disabled = !paused;
    this.buttons.stepIn.disabled = !paused;
    this.buttons.stepOut.disabled = !paused;
    this.buttons.stop.disabled = !active;
  }
}
