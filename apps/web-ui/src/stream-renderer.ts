import type { CockpitChatMessage, Zone3MultiChatState } from "./stores.js";
import type { AtomicStore } from "./stores.js";

function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderMarkdownBlockToHtml(block: string): string {
  const trimmed = block.trim();
  if (trimmed.startsWith("```")) {
    const firstNewline = trimmed.indexOf("\n");
    const lang = firstNewline > 3 ? trimmed.slice(3, firstNewline).trim() : "";
    const body =
      firstNewline >= 0
        ? trimmed.slice(firstNewline + 1).replace(/```$/, "")
        : trimmed.slice(3).replace(/```$/, "");
    return `<pre data-lang="${escapeHtml(lang)}"><code>${escapeHtml(body)}</code></pre>`;
  }
  if (trimmed.startsWith("# ")) {
    return `<h1>${escapeHtml(trimmed.slice(2))}</h1>`;
  }
  if (trimmed.startsWith("## ")) {
    return `<h2>${escapeHtml(trimmed.slice(3))}</h2>`;
  }
  if (trimmed.startsWith("### ")) {
    return `<h3>${escapeHtml(trimmed.slice(4))}</h3>`;
  }
  return `<p>${escapeHtml(trimmed)}</p>`;
}

/**
 * Incremental block-level Markdown parser caching finalized paragraphs and closed code fences
 * so streaming long messages never re-parses already stabilized blocks (`LOT-005` §4.8).
 */
export class IncrementalMarkdownCache {
  private readonly finalizedRawBlocks: string[] = [];
  private readonly finalizedHtmlBlocks: string[] = [];
  private parseCalls = 0;

  update(fullMarkdown: string): readonly string[] {
    const rawBlocks = this.splitStableAndTailBlocks(fullMarkdown);
    const stableCount = Math.max(0, rawBlocks.length - 1);

    for (let i = 0; i < stableCount; i += 1) {
      const raw = rawBlocks[i] ?? "";
      if (this.finalizedRawBlocks[i] !== raw) {
        this.finalizedRawBlocks[i] = raw;
        this.finalizedHtmlBlocks[i] = renderMarkdownBlockToHtml(raw);
        this.parseCalls += 1;
      }
    }
    this.finalizedRawBlocks.length = stableCount;
    this.finalizedHtmlBlocks.length = stableCount;

    if (rawBlocks.length === 0) {
      return [];
    }
    const tailBlock = rawBlocks[rawBlocks.length - 1] ?? "";
    this.parseCalls += 1;
    const tailHtml = renderMarkdownBlockToHtml(tailBlock);
    return [...this.finalizedHtmlBlocks, tailHtml];
  }

  getParseCallCount(): number {
    return this.parseCalls;
  }

  getCachedStableBlockCount(): number {
    return this.finalizedHtmlBlocks.length;
  }

  private splitStableAndTailBlocks(markdown: string): string[] {
    if (markdown.length === 0) {
      return [];
    }
    const blocks: string[] = [];
    let current = "";
    let insideFence = false;
    const lines = markdown.split("\n");

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.trimStart().startsWith("```")) {
        insideFence = !insideFence;
      }
      if (!insideFence && line.trim() === "" && current.trim().length > 0) {
        blocks.push(current);
        current = "";
      } else {
        current = current.length === 0 ? line : `${current}\n${line}`;
      }
    }
    if (current.length > 0) {
      blocks.push(current);
    }
    return blocks;
  }
}

export type FrameScheduler = (callback: () => void) => void;

function defaultFrameScheduler(callback: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => callback());
  } else {
    setTimeout(callback, 16);
  }
}

interface PendingChatStreamBuffer {
  readonly chatId: string;
  readonly messageId: string;
  appendedTokens: string;
  completed: boolean;
}

/**
 * Coalesces incoming AI stream tokens (e.g. 150 tokens/s) and continuous terminal log lines
 * into `16 ms` (`requestAnimationFrame`) batches on `Zone3MultiChatStore`, preventing WebView main-thread saturation
 * and guaranteeing `0` re-renders on `Zone2` (file tree) and `Zone4` (CodeMirror 6 inspector).
 */
export class FrameBatchedStreamRenderer {
  private readonly zone3Store: AtomicStore<Zone3MultiChatState>;
  private readonly scheduleFrame: FrameScheduler;
  private readonly pendingTokenBuffers = new Map<string, PendingChatStreamBuffer>();
  private readonly pendingTerminalLogs = new Map<string, string[]>();
  private readonly markdownCaches = new Map<string, IncrementalMarkdownCache>();
  private frameScheduled = false;
  private flushCount = 0;
  private totalIngestedTokens = 0;
  private totalIngestedLogLines = 0;

  constructor(
    zone3Store: AtomicStore<Zone3MultiChatState>,
    scheduleFrame: FrameScheduler = defaultFrameScheduler,
  ) {
    this.zone3Store = zone3Store;
    this.scheduleFrame = scheduleFrame;
  }

  /**
   * Queue an incoming AI token chunk for `(chatId, messageId)` without mutating the store until the next 16 ms frame.
   */
  enqueueToken(chatId: string, messageId: string, tokenChunk: string, completed = false): void {
    const key = `${chatId}::${messageId}`;
    const existing = this.pendingTokenBuffers.get(key);
    if (existing) {
      existing.appendedTokens += tokenChunk;
      existing.completed = existing.completed || completed;
    } else {
      this.pendingTokenBuffers.set(key, {
        chatId,
        messageId,
        appendedTokens: tokenChunk,
        completed,
      });
    }
    this.totalIngestedTokens += 1;
    this.ensureFrameScheduled();
  }

  /**
   * Queue a terminal log line for `chatId` to be flushed in the same 16 ms frame tick.
   */
  enqueueTerminalLog(chatId: string, logLine: string): void {
    const list = this.pendingTerminalLogs.get(chatId);
    if (list) {
      list.push(logLine);
    } else {
      this.pendingTerminalLogs.set(chatId, [logLine]);
    }
    this.totalIngestedLogLines += 1;
    this.ensureFrameScheduled();
  }

  /**
   * Synchronously flush all buffered tokens and terminal logs in a single atomic store update.
   */
  flushNow(): void {
    this.frameScheduled = false;
    if (this.pendingTokenBuffers.size === 0 && this.pendingTerminalLogs.size === 0) {
      return;
    }

    const tokenEntries = Array.from(this.pendingTokenBuffers.values());
    const logEntries = Array.from(this.pendingTerminalLogs.entries());
    this.pendingTokenBuffers.clear();
    this.pendingTerminalLogs.clear();
    this.flushCount += 1;

    this.zone3Store.setState((prev) => {
      const nextMessagesByChat: Record<string, readonly CockpitChatMessage[]> = {
        ...prev.messagesByChatId,
      };
      const nextLogsByChat: Record<string, readonly string[]> = {
        ...prev.terminalLogsByChatId,
      };

      for (const entry of tokenEntries) {
        const currentList = [...(nextMessagesByChat[entry.chatId] ?? [])];
        const msgKey = `${entry.chatId}::${entry.messageId}`;
        let mdCache = this.markdownCaches.get(msgKey);
        if (!mdCache) {
          mdCache = new IncrementalMarkdownCache();
          this.markdownCaches.set(msgKey, mdCache);
        }

        const idx = currentList.findIndex((m) => m.messageId === entry.messageId);
        const existingMsg = idx >= 0 ? currentList[idx] : undefined;
        if (existingMsg) {
          const updatedContent = existingMsg.content + entry.appendedTokens;
          const renderedHtmlBlocks = mdCache.update(updatedContent);
          currentList[idx] = {
            ...existingMsg,
            content: updatedContent,
            renderedHtmlBlocks,
            streaming: !entry.completed,
          };
        } else {
          const renderedHtmlBlocks = mdCache.update(entry.appendedTokens);
          currentList.push({
            messageId: entry.messageId,
            chatId: entry.chatId,
            role: "assistant",
            content: entry.appendedTokens,
            renderedHtmlBlocks,
            streaming: !entry.completed,
          });
        }
        nextMessagesByChat[entry.chatId] = currentList;
      }

      for (const [chatId, lines] of logEntries) {
        const existingLogs = nextLogsByChat[chatId] ?? [];
        nextLogsByChat[chatId] = [...existingLogs, ...lines];
      }

      return {
        ...prev,
        messagesByChatId: nextMessagesByChat,
        terminalLogsByChatId: nextLogsByChat,
      };
    });
  }

  getStats(): {
    readonly flushCount: number;
    readonly totalIngestedTokens: number;
    readonly totalIngestedLogLines: number;
  } {
    return {
      flushCount: this.flushCount,
      totalIngestedTokens: this.totalIngestedTokens,
      totalIngestedLogLines: this.totalIngestedLogLines,
    };
  }

  getMarkdownCache(chatId: string, messageId: string): IncrementalMarkdownCache | undefined {
    return this.markdownCaches.get(`${chatId}::${messageId}`);
  }

  private ensureFrameScheduled(): void {
    if (this.frameScheduled) {
      return;
    }
    this.frameScheduled = true;
    this.scheduleFrame(() => {
      if (this.frameScheduled) {
        this.flushNow();
      }
    });
  }
}
