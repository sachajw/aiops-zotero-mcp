/**
 * The Assistant section in the item pane (it also shows in the reader's side pane) and the item
 * context menu: Summarise to note, Suggest tags, Suggest collection.
 *
 * Every change goes through the plugin's own write tools, first as a dry run and then for real,
 * only after the user clicks Apply. Model and document text is rendered with textContent only:
 * this is a privileged window, so it must never be parsed as markup.
 */
import {
  type CollectionSuggestion,
  type TagProposal,
  collectionsRequest,
  parseCollectionProposal,
  parseSummary,
  parseTagProposal,
  summaryNote,
  summaryRequest,
  tagsRequest,
} from "../assistant/actions.js";
import { CancelledError, send } from "../assistant/transport.js";
import {
  actionSettings,
  collectionChoices,
  collectionKeysOf,
  itemContext,
  libraryTags,
  testConnection,
  transportDeps,
} from "../assistant/zotero.js";
import { runTool } from "../mcp/runner.js";
import type { ToolDefinition } from "../mcp/tool.js";
import { writeTools } from "../tools/write.js";
import { collectionPath } from "../zotero/library.js";
import { itemChatConfig, mountChat, stopAllChats, unmountChat, watchDeletions } from "./chat.js";
import { backendSummary, button, checkbox, el } from "./dom.js";
import { closeLibraryAssistant, openLibraryAssistant } from "./window.js";

type ActionKind = "summary" | "tags" | "collections";

type PaneState =
  | { status: "running"; kind: ActionKind; label: string; cancel?: () => void }
  | { status: "error"; kind: ActionKind; message: string }
  | { status: "summary"; note: string; model: string; backend: string }
  | { status: "tags"; proposal: TagProposal; model: string; backend: string }
  | { status: "collections"; suggestions: CollectionSuggestion[]; model: string; backend: string }
  | { status: "applying"; message: string }
  | { status: "done"; message: string };

const FTL = "aiops-zotero-mcp.ftl";
const WRITE_TOOLS: ReadonlyMap<string, ToolDefinition> = new Map(writeTools.map((t) => [t.name, t as unknown as ToolDefinition]));

const states = new Map<number, PaneState>();
const mounts = new Map<HTMLElement, { itemID: number; doc: Document }>();
let sectionKey: string | false = false;
let menuID: string | false = false;
let toolsMenuID: string | false = false;
let collectionMenuID: string | false = false;
let prefPaneID: string | undefined;

// ------------------------------------------------------------------ actions

function eligible(item: ZoteroAPI.Item | undefined): item is ZoteroAPI.Item {
  return Boolean(item && !item.deleted && (item.isRegularItem() || (item.isAttachment() && item.isTopLevelItem())));
}

function setState(itemID: number, state: PaneState): void {
  states.set(itemID, state);
  for (const [body, mount] of mounts) {
    if (mount.itemID === itemID) render(body, mount.doc, itemID);
  }
}

const RUNNING_LABEL: Record<ActionKind, string> = {
  summary: "Summarising",
  tags: "Suggesting tags",
  collections: "Suggesting collections",
};

export async function runAction(item: ZoteroAPI.Item, kind: ActionKind): Promise<void> {
  if (states.get(item.id)?.status === "running") return;
  setState(item.id, { status: "running", kind, label: `${RUNNING_LABEL[kind]}…` });
  try {
    const settings = await actionSettings();
    const where = `${settings.model} via ${settings.backend.label}`;
    setState(item.id, { status: "running", kind, label: `${RUNNING_LABEL[kind]} with ${where}…` });
    const ctx = await itemContext(item, settings.contextChars);
    const request =
      kind === "summary"
        ? summaryRequest(ctx, settings.model, settings.maxTokens)
        : kind === "tags"
          ? tagsRequest(ctx, await libraryTags(item.libraryID), settings.model, settings.maxTokens)
          : collectionsRequest(ctx, collectionChoices(item.libraryID), settings.model, settings.maxTokens);
    const message = await send(transportDeps(), settings.backend, request, {
      timeoutSeconds: settings.timeoutSeconds,
      onCancel: (cancel) => {
        const s = states.get(item.id);
        if (s?.status === "running") setState(item.id, { ...s, cancel });
      },
    });
    const meta = { model: message.model ?? settings.model, backend: settings.backend.label };
    if (kind === "summary") {
      const note = summaryNote(parseSummary(message), { ...meta, date: new Date().toISOString().slice(0, 10), ctx });
      setState(item.id, { status: "summary", note, ...meta });
    } else if (kind === "tags") {
      const proposal = parseTagProposal(message, await libraryTags(item.libraryID), ctx.tags);
      setState(item.id, { status: "tags", proposal, ...meta });
    } else {
      const suggestions = parseCollectionProposal(message, collectionChoices(item.libraryID), collectionKeysOf(item));
      setState(item.id, { status: "collections", suggestions, ...meta });
    }
  } catch (error) {
    if (error instanceof CancelledError) {
      states.delete(item.id);
      setState(item.id, { status: "done", message: "Cancelled." });
      return;
    }
    setState(item.id, { status: "error", kind, message: error instanceof Error ? error.message : String(error) });
  }
}

/** Dry run, then the real call; stops at the first error. */
async function apply(itemID: number, tool: string, args: Record<string, unknown>, done: string): Promise<void> {
  setState(itemID, { status: "applying", message: "Applying…" });
  const preview = await runTool(WRITE_TOOLS, tool, { ...args, dry_run: true }, { logError: (e) => Zotero.logError(e) });
  if (preview.kind === "unknown" || preview.isError) {
    setState(itemID, { status: "done", message: `Nothing changed: ${preview.kind === "unknown" ? "unknown tool" : preview.text}` });
    return;
  }
  const result = await runTool(WRITE_TOOLS, tool, { ...args, dry_run: false }, { logError: (e) => Zotero.logError(e) });
  setState(itemID, {
    status: "done",
    message: result.kind === "result" && !result.isError ? done : `Failed: ${result.kind === "result" ? result.text : "unknown tool"}`,
  });
}

// ---------------------------------------------------------------- rendering

function render(body: HTMLElement, doc: Document, itemID: number): void {
  const item = Zotero.Items.get(itemID);
  if (!item || !eligible(item)) {
    body.replaceChildren();
    delete body.dataset.aiopsItem;
    return;
  }
  // The chat area is built once per item (so typing and streaming aren't disturbed); the
  // actions area is redrawn on every change.
  if (body.dataset.aiopsItem !== String(itemID)) {
    const chatArea = el(doc, "div");
    body.replaceChildren(el(doc, "div"), el(doc, "div", "Chat", "font-weight: 600; margin-top: 8px;"), chatArea);
    body.dataset.aiopsItem = String(itemID);
    mountChat(chatArea, doc, itemChatConfig(item), rerenderAll);
  }
  const area = body.firstElementChild as HTMLElement;
  area.replaceChildren();
  const state = states.get(itemID);
  const busy = state?.status === "running" || state?.status === "applying";

  const actions = el(doc, "div");
  actions.append(
    button(doc, "Summarise", () => void runAction(item, "summary"), busy),
    button(doc, "Suggest tags", () => void runAction(item, "tags"), busy),
    button(doc, "Suggest collection", () => void runAction(item, "collections"), busy || !item.isTopLevelItem()),
  );
  area.append(actions);
  if (!state) {
    area.append(el(doc, "div", "Actions change nothing until you click Apply.", "opacity: 0.7;"));
    return;
  }

  const panel = el(doc, "div", undefined, "margin-top: 4px;");
  area.append(panel);
  const by = (s: { model: string; backend: string }) => el(doc, "div", `From ${s.model} via ${s.backend}.`, "opacity: 0.7; margin-bottom: 4px;");
  const discard = () => button(doc, "Discard", () => { states.delete(itemID); render(body, doc, itemID); });

  switch (state.status) {
    case "running":
      panel.append(el(doc, "div", state.label), button(doc, "Stop", () => state.cancel?.(), !state.cancel));
      break;
    case "applying":
    case "done":
      panel.append(el(doc, "div", state.message));
      break;
    case "error":
      panel.append(el(doc, "div", state.message, "color: var(--accent-red, #c00); white-space: pre-wrap;"));
      break;
    case "summary": {
      panel.append(by(state), el(doc, "div", state.note, "white-space: pre-wrap; user-select: text;"));
      const args = item.isRegularItem()
        ? { text: state.note, parent_item_key: item.key, library_id: item.libraryID }
        : { text: state.note, collection_keys: collectionKeysOf(item), library_id: item.libraryID };
      panel.append(
        el(doc, "div"),
        button(doc, "Save as note", () => void apply(itemID, "zotero_add_note", args, "Saved the summary as a note.")),
        discard(),
      );
      break;
    }
    case "tags": {
      const { existing, proposedNew } = state.proposal;
      panel.append(by(state));
      if (!existing.length && !proposedNew.length) {
        panel.append(el(doc, "div", "No tags to add: the suggestions were all tags the item already has."), discard());
        break;
      }
      const boxes = [
        ...existing.map((t) => ({ tag: t, ...checkbox(doc, t, true) })),
        ...proposedNew.map((t) => ({ tag: t, ...checkbox(doc, t, false, "(new tag)") })),
      ];
      boxes.forEach((b) => panel.append(b.row));
      panel.append(
        button(doc, "Add selected tags", () => {
          const add = boxes.filter((b) => b.input.checked).map((b) => b.tag);
          if (add.length) void apply(itemID, "zotero_set_tags", { item_keys: [item.key], add, library_id: item.libraryID }, `Added ${add.length} tag(s).`);
        }),
        discard(),
      );
      break;
    }
    case "collections": {
      panel.append(by(state));
      if (!state.suggestions.length) {
        panel.append(el(doc, "div", "No suggestions: nothing fitted better than where it already is."), discard());
        break;
      }
      const boxes = state.suggestions.map((s, i) => ({ key: s.key, ...checkbox(doc, s.path, i === 0, s.reason ? `: ${s.reason}` : "") }));
      boxes.forEach((b) => panel.append(b.row));
      panel.append(
        button(doc, "Add to selected", () => {
          const add = boxes.filter((b) => b.input.checked).map((b) => b.key);
          if (add.length) void apply(itemID, "zotero_set_collections", { item_keys: [item.key], add, library_id: item.libraryID }, `Added to ${add.length} collection(s).`);
        }),
        discard(),
      );
      break;
    }
  }
}

function rerenderAll(): void {
  for (const [body, mount] of mounts) render(body, mount.doc, mount.itemID);
}

// ------------------------------------------------------------- registration

function revealSection(): void {
  const details = Zotero.getMainWindow()?.ZoteroPane.itemPane?._itemDetails;
  if (sectionKey && details) details.scrollToPane(sectionKey);
}

function menuItem(l10nID: string, kind: ActionKind): ZoteroUI.MenuData {
  return {
    menuType: "menuitem",
    l10nID,
    onShowing: (_event, ctx) => {
      const items = ctx.items ?? [];
      ctx.setEnabled(items.length === 1 && eligible(items[0]) && (kind !== "collections" || items[0].isTopLevelItem()));
    },
    onCommand: (_event, ctx) => {
      const item = ctx.items?.[0];
      if (!eligible(item)) return;
      revealSection();
      void runAction(item, kind);
    },
  };
}

/** Make the plugin's Fluent strings available in a main window (for the section header and menus). */
export function addStrings(win: { MozXULElement: { insertFTLIfNeeded(file: string): void } }): void {
  win.MozXULElement.insertFTLIfNeeded(FTL);
}

export function removeStrings(win: Window): void {
  win.document.querySelector(`[href="${FTL}"]`)?.remove();
}

export function registerAssistant(pluginID: string, rootURI: string): void {
  const icon = `${rootURI}content/icons/assistant.svg`;
  sectionKey = Zotero.ItemPaneManager.registerSection({
    paneID: "assistant",
    pluginID,
    header: { l10nID: "aiops-assistant-header", icon },
    sidenav: { l10nID: "aiops-assistant-sidenav", icon },
    onItemChange: ({ item, setEnabled }) => setEnabled(eligible(item)),
    onRender: ({ body, doc, item, setSectionSummary }) => {
      // Zotero renders sections while nothing is selected too (item undefined).
      if (!item) {
        mounts.delete(body);
        body.replaceChildren();
        delete body.dataset.aiopsItem;
        return;
      }
      mounts.set(body, { itemID: item.id, doc });
      setSectionSummary(backendSummary());
      render(body, doc, item.id);
    },
    onDestroy: ({ body }) => {
      mounts.delete(body);
      const chatArea = body.lastElementChild;
      if (chatArea) unmountChat(chatArea as HTMLElement);
    },
  });
  menuID = Zotero.MenuManager.registerMenu({
    menuID: "aiops-assistant-item",
    pluginID,
    target: "main/library/item",
    menus: [
      {
        menuType: "submenu",
        l10nID: "aiops-assistant-menu",
        menus: [
          menuItem("aiops-assistant-summarise", "summary"),
          menuItem("aiops-assistant-suggest-tags", "tags"),
          menuItem("aiops-assistant-suggest-collections", "collections"),
        ],
      },
    ],
  });
  watchDeletions();
  toolsMenuID = Zotero.MenuManager.registerMenu({
    menuID: "aiops-assistant-tools",
    pluginID,
    target: "main/menubar/tools",
    menus: [{ menuType: "menuitem", l10nID: "aiops-library-assistant", onCommand: () => openLibraryAssistant() }],
  });
  collectionMenuID = Zotero.MenuManager.registerMenu({
    menuID: "aiops-assistant-collection",
    pluginID,
    target: "main/library/collection",
    menus: [
      {
        menuType: "menuitem",
        l10nID: "aiops-assistant-ask-collection",
        onShowing: (_event, ctx) => {
          const rows = ctx.collectionTreeRows ?? [];
          ctx.setVisible(rows.length === 1 && rows[0].isCollection());
        },
        onCommand: (_event, ctx) => {
          const row = ctx.collectionTreeRows?.[0];
          if (!row?.isCollection()) return;
          const path = collectionPath(row.ref, (id) => Zotero.Collections.get(id));
          openLibraryAssistant(`About the collection "${path}" (${row.ref.key}): `);
        },
      },
    ],
  });
  const win = Zotero.getMainWindow();
  if (win) addStrings(win);
  // The Settings pane's Test connection button calls this (its script runs in the Settings window).
  (Zotero as unknown as Record<string, unknown>).AiopsZoteroMcp = { testConnection };
  Zotero.PreferencePanes.register({
    pluginID,
    src: "content/preferences.xhtml",
    scripts: ["content/preferences.js"],
    label: "Zotero MCP Assistant",
  }).then((id) => {
    prefPaneID = id;
  }, (e: unknown) => Zotero.logError(e));
}

export function unregisterAssistant(): void {
  stopAllChats();
  for (const state of states.values()) if (state.status === "running") state.cancel?.();
  states.clear();
  mounts.clear();
  if (sectionKey) Zotero.ItemPaneManager.unregisterSection(sectionKey);
  for (const id of [menuID, toolsMenuID, collectionMenuID]) if (id) Zotero.MenuManager.unregisterMenu(id);
  sectionKey = menuID = toolsMenuID = collectionMenuID = false;
  closeLibraryAssistant();
  if (prefPaneID) Zotero.PreferencePanes.unregister(prefPaneID);
  prefPaneID = undefined;
  Reflect.deleteProperty(Zotero, "AiopsZoteroMcp");
  const win = Zotero.getMainWindow();
  if (win) removeStrings(win);
}
