/**
 * Chat about the open item, in the Assistant section. One conversation per item, kept in memory
 * while Zotero runs. The model can read the library (read-only tools), not change it.
 */
import { type AgentEvent, runAgent, trimHistory } from "../assistant/agent.js";
import type { ContentBlock, MessageParam } from "../assistant/anthropic.js";
import { chatSystem } from "../assistant/chat.js";
import { resolveModel } from "../assistant/config.js";
import { agentTools } from "../assistant/toolset.js";
import { CancelledError, send } from "../assistant/transport.js";
import { actionSettings, itemContext, numberPref, stringPref, transportDeps } from "../assistant/zotero.js";
import type { ToolDefinition } from "../mcp/tool.js";
import { readTools } from "../tools/read.js";
import { backendPicker, button, el } from "./dom.js";

/** Conversation size kept below this many characters, trimming old tool output first. */
const HISTORY_CHARS = 300_000;

type ViewEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; tools: string[]; note?: string; error?: boolean };

interface Chat {
  system?: string;
  /** Which backend the history was built with; thinking blocks don't carry across backends. */
  backend?: string;
  messages: MessageParam[];
  view: ViewEntry[];
  running: boolean;
  cancelled: boolean;
  cancel?: () => void;
  draft: string;
}

interface Mount {
  itemID: number;
  doc: Document;
  log: HTMLElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
  newChat: HTMLButtonElement;
}

const chats = new Map<number, Chat>();
const mounts = new Map<HTMLElement, Mount>();
const READ_TOOLS = readTools as unknown as ToolDefinition[];

function chatFor(itemID: number): Chat {
  let chat = chats.get(itemID);
  if (!chat) {
    chat = { messages: [], view: [], running: false, cancelled: false, draft: "" };
    chats.set(itemID, chat);
  }
  return chat;
}

const TOOL_LABEL: Record<string, string> = {
  zotero_get_fulltext: "Reading the full text",
  zotero_get_annotations: "Reading annotations",
  zotero_list_notes: "Reading notes",
  zotero_search_items: "Searching the library",
  zotero_get_item: "Looking up an item",
  zotero_list_collections: "Looking at collections",
  zotero_cite: "Formatting a citation",
};

// ---------------------------------------------------------------- rendering

function renderLog(mount: Mount, chat: Chat): void {
  const { doc, log } = mount;
  log.replaceChildren();
  for (const entry of chat.view) {
    const box = el(doc, "div", undefined, "margin: 6px 0;");
    if (entry.role === "user") {
      box.append(el(doc, "div", "You", "font-weight: 600;"), el(doc, "div", entry.text, "white-space: pre-wrap; user-select: text;"));
    } else {
      box.append(el(doc, "div", "Assistant", "font-weight: 600;"));
      for (const t of entry.tools) box.append(el(doc, "div", `${t}…`, "opacity: 0.6; font-size: 0.9em;"));
      if (entry.text) box.append(el(doc, "div", entry.text, "white-space: pre-wrap; user-select: text;"));
      else if (chat.running && entry === chat.view.at(-1)) box.append(el(doc, "div", "…", "opacity: 0.6;"));
      if (entry.note) {
        box.append(el(doc, "div", entry.note, entry.error ? "color: var(--accent-red, #c00); white-space: pre-wrap;" : "opacity: 0.6; font-size: 0.9em;"));
      }
    }
    log.append(box);
  }
  mount.send.disabled = chat.running;
  mount.stop.disabled = !chat.running || !chat.cancel;
  mount.newChat.disabled = chat.running || !chat.view.length;
}

function refresh(itemID: number): void {
  const chat = chatFor(itemID);
  for (const mount of mounts.values()) if (mount.itemID === itemID) renderLog(mount, chat);
}

/** Build the chat area once per mounted item; later updates only redraw the log. */
export function mountChat(container: HTMLElement, doc: Document, itemID: number, rerenderAll: () => void): void {
  const chat = chatFor(itemID);
  const input = el(doc, "textarea", undefined, "width: 100%; box-sizing: border-box; min-height: 3.5em; resize: vertical;");
  input.placeholder = "Ask about this item (Enter to send, Shift+Enter for a new line)";
  input.value = chat.draft;
  const sendButton = button(doc, "Send", () => void ask(itemID, input));
  const stop = button(doc, "Stop", () => chatFor(itemID).cancel?.());
  const newChat = button(doc, "New chat", () => {
    chats.delete(itemID);
    refresh(itemID);
  });
  input.addEventListener("input", () => {
    chatFor(itemID).draft = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void ask(itemID, input);
    }
  });
  const log = el(doc, "div", undefined, "max-height: 60vh; overflow-y: auto;");
  container.replaceChildren(
    el(doc, "div", "Chat", "font-weight: 600; margin-top: 8px;"),
    backendPicker(doc, rerenderAll),
    log,
    input,
    el(doc, "div"),
  );
  container.lastElementChild?.append(sendButton, stop, newChat);
  const mount = { itemID, doc, log, input, send: sendButton, stop, newChat };
  mounts.set(container, mount);
  renderLog(mount, chat);
}

export function unmountChat(container: HTMLElement): void {
  mounts.delete(container);
}

// ------------------------------------------------------------------ sending

/** Thinking blocks are signed by the backend that wrote them; drop them when switching. */
function withoutThinking(messages: MessageParam[]): MessageParam[] {
  return messages.map((m) =>
    Array.isArray(m.content)
      ? { ...m, content: m.content.filter((b: ContentBlock) => b.type !== "thinking" && b.type !== "redacted_thinking") }
      : m,
  );
}

async function ask(itemID: number, input: HTMLTextAreaElement): Promise<void> {
  const chat = chatFor(itemID);
  const question = input.value.trim();
  const item = Zotero.Items.get(itemID);
  if (!question || chat.running || !item) return;
  input.value = "";
  chat.draft = "";

  const before = chat.messages;
  const entry: ViewEntry = { role: "assistant", text: "", tools: [] };
  chat.view.push({ role: "user", text: question }, entry);
  chat.running = true;
  chat.cancelled = false;
  chat.cancel = undefined;
  refresh(itemID);

  let lastPaint = 0;
  const paint = () => {
    const now = Date.now();
    if (now - lastPaint > 80) {
      lastPaint = now;
      refresh(itemID);
    }
  };
  try {
    const settings = await actionSettings();
    const model = resolveModel(settings.backend, stringPref("chatModel", "sonnet"));
    if (chat.backend && chat.backend !== settings.backend.label) chat.messages = withoutThinking(chat.messages);
    chat.backend = settings.backend.label;
    chat.system ??= chatSystem(await itemContext(item, settings.contextChars));
    const history = trimHistory([...chat.messages, { role: "user", content: question }], HISTORY_CHARS);
    const outcome = await runAgent(history, {
      send: (request, onText) =>
        send(transportDeps(), settings.backend, request, {
          timeoutSeconds: settings.timeoutSeconds,
          onText,
          onCancel: (cancel) => {
            chat.cancel = cancel;
            refresh(itemID);
          },
        }),
      request: { model, max_tokens: settings.maxTokens, system: chat.system },
      tools: agentTools(READ_TOOLS, { writes: false }, { logError: (e) => Zotero.logError(e) }),
      maxIterations: numberPref("maxToolIterations", 10, 1, 50),
      maxToolResultChars: numberPref("maxToolResultChars", 20_000, 1_000, 100_000),
      onEvent: (event: AgentEvent) => {
        if (event.type === "text") entry.text += event.delta;
        if (event.type === "tool") entry.tools.push(TOOL_LABEL[event.name] ?? event.name);
        paint();
      },
      isCancelled: () => chat.cancelled,
    });
    if (outcome.stopped === "cancelled") throw new CancelledError();
    chat.messages = outcome.messages;
    entry.note = `${model} via ${settings.backend.label}` + (outcome.stopped === "max_iterations" ? " (stopped at the tool-use limit)" : "");
    if (!outcome.text && !entry.text) entry.text = "(No answer.)";
  } catch (error) {
    chat.messages = before; // the unanswered question isn't kept, so the next one starts cleanly
    if (error instanceof CancelledError) entry.note = "Stopped.";
    else {
      entry.note = error instanceof Error ? error.message : String(error);
      entry.error = true;
    }
  } finally {
    chat.running = false;
    chat.cancel = undefined;
    refresh(itemID);
  }
}

/** Stop everything (plugin shutdown). */
export function stopAllChats(): void {
  for (const chat of chats.values()) {
    chat.cancelled = true;
    chat.cancel?.();
  }
  chats.clear();
  mounts.clear();
}
