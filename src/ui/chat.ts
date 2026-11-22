/**
 * Chats: one about the open item (in the Assistant section; read-only) and the library assistant
 * (its own window; can change the library, but only after the user approves each change).
 * Conversations are kept in memory while Zotero runs.
 */
import { type AgentEvent, type PendingWrite, runAgent, trimHistory } from "../assistant/agent.js";
import type { ContentBlock, MessageParam } from "../assistant/anthropic.js";
import { chatSystem, keysIn, librarySystem } from "../assistant/chat.js";
import { type ViewEntry, deletedChatKeys, parseStoredChat, serializeChat, storeFileName } from "../assistant/store.js";
import { agentTools } from "../assistant/toolset.js";
import { CancelledError, send } from "../assistant/transport.js";
import { actionSettings, chatStore, describeKey, itemContext, modelFor, numberPref, transportDeps } from "../assistant/zotero.js";
import type { ToolDefinition } from "../mcp/tool.js";
import { readTools } from "../tools/read.js";
import { writeTools } from "../tools/write.js";
import { backendPicker, button, el } from "./dom.js";
import { renderMarkdown } from "./markdown.js";

/** Conversation size kept below this many characters, trimming old tool output first. */
const HISTORY_CHARS = 300_000;
const READ_TOOLS = readTools as unknown as ToolDefinition[];
const ALL_TOOLS = [...readTools, ...writeTools] as unknown as ToolDefinition[];

export interface ChatConfig {
  /** Which conversation: "item:<id>" or "library". */
  key: string;
  /** Whether the model may propose changes (each needs approval). */
  writes: boolean;
  placeholder: string;
  system(): Promise<string>;
  /** The library whose keys the approval card resolves. */
  libraryID: number;
}

interface Pending {
  write: PendingWrite;
  legend: string[];
  resolve(approved: boolean): void;
}

interface Chat {
  system?: string;
  /** Which backend the history was built with; thinking blocks don't carry across backends. */
  backend?: string;
  messages: MessageParam[];
  view: ViewEntry[];
  running: boolean;
  cancelled: boolean;
  cancel?: () => void;
  pending?: Pending;
  draft: string;
  /** True until the saved conversation (if any) has been read from disk. */
  loading: boolean;
}

interface Mount {
  config: ChatConfig;
  doc: Document;
  log: HTMLElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
  newChat: HTMLButtonElement;
}

const chats = new Map<string, Chat>();
const mounts = new Map<HTMLElement, Mount>();

function chatFor(key: string): Chat {
  let chat = chats.get(key);
  if (!chat) {
    const created: Chat = { messages: [], view: [], running: false, cancelled: false, draft: "", loading: true };
    chats.set(key, created);
    void restore(key, created);
    chat = created;
  }
  return chat;
}

/** Read a saved conversation into a fresh chat, unless the user already started typing in it. */
async function restore(key: string, chat: Chat): Promise<void> {
  const name = storeFileName(key);
  try {
    const json = name ? await chatStore.read(name) : undefined;
    const saved = json ? parseStoredChat(json) : undefined;
    if (saved && chats.get(key) === chat && !chat.running && !chat.view.length) {
      chat.messages = saved.messages;
      chat.view = saved.view;
      chat.backend = saved.backend;
    }
  } catch (e) {
    Zotero.logError(e);
  } finally {
    chat.loading = false;
    if (chats.get(key) === chat) refresh(key);
  }
}

async function save(key: string, chat: Chat): Promise<void> {
  const name = storeFileName(key);
  if (!name) return;
  try {
    await chatStore.write(name, serializeChat({ backend: chat.backend, messages: trimHistory(chat.messages, HISTORY_CHARS), view: chat.view }));
  } catch (e) {
    Zotero.logError(e);
  }
}

export function itemChatConfig(item: ZoteroAPI.Item): ChatConfig {
  return {
    key: `item:${item.libraryID}:${item.key}`,
    writes: false,
    libraryID: item.libraryID,
    placeholder: "Ask about this item (Enter to send, Shift+Enter for a new line)",
    system: async () => {
      const settings = await actionSettings();
      return chatSystem(await itemContext(item, settings.contextChars));
    },
  };
}

export function libraryChatConfig(): ChatConfig {
  return {
    key: "library",
    writes: true,
    libraryID: Zotero.Libraries.userLibraryID,
    placeholder: "Ask about your library or ask for a change; every change waits for your approval",
    system: async () => librarySystem(),
  };
}

const TOOL_LABEL: Record<string, string> = {
  zotero_get_fulltext: "Reading the full text",
  zotero_get_annotations: "Reading annotations",
  zotero_list_notes: "Reading notes",
  zotero_search_items: "Searching the library",
  zotero_get_item: "Looking up an item",
  zotero_get_attachment: "Looking up an attachment",
  zotero_list_collections: "Looking at collections",
  zotero_list_libraries: "Looking at libraries",
  zotero_cite: "Formatting a citation",
};

function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? `Preparing a change (${name.replace(/^zotero_/, "").replace(/_/g, " ")})`;
}

// ---------------------------------------------------------------- rendering

function approvalCard(mount: Mount, chat: Chat, pending: Pending): HTMLElement {
  const { doc } = mount;
  const card = el(doc, "div", undefined, "border: 1px solid var(--fill-quinary, #888); border-radius: 6px; padding: 8px; margin: 6px 0;");
  card.append(
    el(doc, "div", `Approve this change? (${pending.write.tool.replace(/^zotero_/, "").replace(/_/g, " ")})`, "font-weight: 600;"),
    el(doc, "div", pending.write.preview.slice(0, 6000), "white-space: pre-wrap; max-height: 40vh; overflow-y: auto; font-size: 0.9em; margin: 4px 0;"),
  );
  if (pending.legend.length) {
    card.append(el(doc, "div", pending.legend.join("\n"), "white-space: pre-wrap; opacity: 0.8; font-size: 0.9em; margin-bottom: 4px;"));
  }
  if (/trash/.test(pending.write.tool)) {
    card.append(el(doc, "div", "Moves to Zotero's trash; restorable from there.", "opacity: 0.8; margin-bottom: 4px;"));
  }
  const decide = (approved: boolean) => () => {
    if (chat.pending !== pending) return;
    chat.pending = undefined;
    pending.resolve(approved);
    refresh(mount.config.key);
  };
  card.append(button(doc, "Approve", decide(true)), button(doc, "Reject", decide(false)));
  return card;
}

function renderLog(mount: Mount, chat: Chat): void {
  const { doc, log } = mount;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.replaceChildren();
  for (const entry of chat.view) {
    const box = el(doc, "div", undefined, "margin: 6px 0;");
    if (entry.role === "user") {
      box.append(el(doc, "div", "You", "font-weight: 600;"), el(doc, "div", entry.text, "white-space: pre-wrap; user-select: text;"));
    } else {
      box.append(el(doc, "div", "Assistant", "font-weight: 600;"));
      for (const t of entry.tools) box.append(el(doc, "div", `${t}…`, "opacity: 0.6; font-size: 0.9em;"));
      if (entry.text) box.append(renderMarkdown(doc, entry.text));
      else if (chat.running && entry === chat.view.at(-1) && !chat.pending) box.append(el(doc, "div", "…", "opacity: 0.6;"));
      if (entry.note) {
        box.append(el(doc, "div", entry.note, entry.error ? "color: var(--accent-red, #c00); white-space: pre-wrap;" : "opacity: 0.6; font-size: 0.9em;"));
      }
    }
    log.append(box);
  }
  if (chat.pending) log.append(approvalCard(mount, chat, chat.pending));
  if (atBottom) log.scrollTop = log.scrollHeight;
  mount.send.disabled = chat.running || chat.loading;
  mount.stop.disabled = !chat.running;
  mount.newChat.disabled = chat.running || !chat.view.length;
}

function refresh(key: string): void {
  const chat = chatFor(key);
  for (const mount of mounts.values()) if (mount.config.key === key) renderLog(mount, chat);
}

function stopChat(chat: Chat): void {
  chat.cancelled = true;
  chat.cancel?.();
  const pending = chat.pending;
  chat.pending = undefined;
  pending?.resolve(false);
}

/** Build the chat area once; later updates only redraw the log. */
export function mountChat(container: HTMLElement, doc: Document, config: ChatConfig, rerenderAll: () => void, logHeight = "60vh"): void {
  const chat = chatFor(config.key);
  const input = el(doc, "textarea", undefined, "width: 100%; box-sizing: border-box; min-height: 3.5em; resize: vertical;");
  input.placeholder = config.placeholder;
  input.value = chat.draft;
  const sendButton = button(doc, "Send", () => void ask(config, input));
  const stop = button(doc, "Stop", () => {
    stopChat(chatFor(config.key));
    refresh(config.key);
  });
  const newChat = button(doc, "New chat", () => {
    chats.set(config.key, { messages: [], view: [], running: false, cancelled: false, draft: "", loading: false });
    const name = storeFileName(config.key);
    if (name) void chatStore.remove(name).catch((e: unknown) => Zotero.logError(e));
    refresh(config.key);
  });
  input.addEventListener("input", () => {
    chatFor(config.key).draft = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void ask(config, input);
    }
  });
  const log = el(doc, "div", undefined, `max-height: ${logHeight}; overflow-y: auto;`);
  const buttons = el(doc, "div");
  buttons.append(sendButton, stop, newChat);
  container.replaceChildren(backendPicker(doc, rerenderAll), log, input, buttons);
  const mount = { config, doc, log, input, send: sendButton, stop, newChat };
  mounts.set(container, mount);
  renderLog(mount, chat);
}

export function unmountChat(container: HTMLElement): void {
  mounts.delete(container);
}

/** Put text in a chat's input (e.g. "About the collection …: "). */
export function setDraft(key: string, text: string): void {
  chatFor(key).draft = text;
  for (const mount of mounts.values()) {
    if (mount.config.key === key) {
      mount.input.value = text;
      mount.input.focus();
    }
  }
}

/** Stop a conversation's request and refuse any pending approval (e.g. its window closed). */
export function stopChatByKey(key: string): void {
  const chat = chats.get(key);
  if (chat) stopChat(chat);
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

async function ask(config: ChatConfig, input: HTMLTextAreaElement): Promise<void> {
  const chat = chatFor(config.key);
  const question = input.value.trim();
  if (!question || chat.running || chat.loading) return;
  input.value = "";
  chat.draft = "";

  const before = chat.messages;
  const entry: ViewEntry = { role: "assistant", text: "", tools: [] };
  chat.view.push({ role: "user", text: question }, entry);
  chat.running = true;
  chat.cancelled = false;
  chat.cancel = undefined;
  refresh(config.key);

  let lastPaint = 0;
  const paint = () => {
    const now = Date.now();
    if (now - lastPaint > 80) {
      lastPaint = now;
      refresh(config.key);
    }
  };
  try {
    const settings = await actionSettings();
    const model = modelFor(settings.backend, "chatModel");
    if (chat.backend && chat.backend !== settings.backend.label) chat.messages = withoutThinking(chat.messages);
    chat.backend = settings.backend.label;
    chat.system ??= await config.system();
    const history = trimHistory([...chat.messages, { role: "user", content: question }], HISTORY_CHARS);
    const outcome = await runAgent(history, {
      send: (request, onText) =>
        send(transportDeps(), settings.backend, request, {
          timeoutSeconds: settings.timeoutSeconds,
          onText,
          onCancel: (cancel) => {
            chat.cancel = cancel;
            refresh(config.key);
          },
        }),
      request: { model, max_tokens: settings.maxTokens, system: chat.system },
      tools: agentTools(config.writes ? ALL_TOOLS : READ_TOOLS, { writes: config.writes }, { logError: (e) => Zotero.logError(e) }),
      maxIterations: numberPref("maxToolIterations", 10, 1, 50),
      maxToolResultChars: numberPref("maxToolResultChars", 20_000, 1_000, 100_000),
      ...(config.writes
        ? {
            approve: (write: PendingWrite) =>
              new Promise<boolean>((resolve) => {
                const legend = keysIn(`${write.preview}\n${JSON.stringify(write.args)}`)
                  .map((k) => describeKey(config.libraryID, k))
                  .filter((d): d is string => Boolean(d));
                chat.pending = { write, legend, resolve };
                refresh(config.key);
              }),
          }
        : {}),
      onEvent: (event: AgentEvent) => {
        if (event.type === "text") entry.text += event.delta;
        if (event.type === "tool") entry.tools.push(toolLabel(event.name));
        if (event.type === "tool_result" && !TOOL_LABEL[event.name]) {
          entry.tools.push(event.isError ? `Not changed: ${event.text.split("\n")[0].slice(0, 200)}` : `Done: ${event.text.split("\n")[0].slice(0, 200)}`);
        }
        paint();
      },
      isCancelled: () => chat.cancelled,
    });
    if (outcome.stopped === "cancelled") {
      // Keep what ran (an approved change stays, so the model knows about it); drop a turn where nothing did.
      if (outcome.kept) chat.messages = outcome.messages;
      throw new CancelledError();
    }
    chat.messages = outcome.messages;
    entry.note = `${model} via ${settings.backend.label}` + (outcome.stopped === "max_iterations" ? " (stopped at the tool-use limit)" : "");
    if (!outcome.text && !entry.text) entry.text = "(No answer.)";
  } catch (error) {
    if (!(error instanceof CancelledError && chat.messages !== before)) {
      chat.messages = before; // a turn that changed nothing isn't kept, so the next one starts cleanly
    }
    if (error instanceof CancelledError) entry.note = "Stopped.";
    else {
      entry.note = error instanceof Error ? error.message : String(error);
      entry.error = true;
    }
  } finally {
    void save(config.key, chat);
    chat.running = false;
    chat.cancel = undefined;
    chat.pending = undefined;
    refresh(config.key);
  }
}

/** Forget a conversation and delete its saved file (e.g. its item was deleted). */
function forget(key: string): void {
  const chat = chats.get(key);
  if (chat) stopChat(chat);
  chats.delete(key);
  const name = storeFileName(key);
  if (name) void chatStore.remove(name).catch((e: unknown) => Zotero.logError(e));
}

let observerID: string | undefined;

/** Delete an item's saved conversation when Zotero deletes the item (emptying the trash, not trashing). */
export function watchDeletions(): void {
  observerID = Zotero.Notifier.registerObserver(
    {
      notify: (event, _type, ids, extraData) => {
        if (event === "delete") deletedChatKeys(ids.map(Number), extraData).forEach(forget);
      },
    },
    ["item"],
    "aiops-zotero-mcp",
  );
}

/** Stop everything (plugin shutdown). */
export function stopAllChats(): void {
  if (observerID) Zotero.Notifier.unregisterObserver(observerID);
  observerID = undefined;
  for (const chat of chats.values()) stopChat(chat);
  chats.clear();
  mounts.clear();
}
