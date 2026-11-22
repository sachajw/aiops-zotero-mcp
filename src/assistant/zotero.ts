/**
 * Zotero-side glue for the assistant: prefs, the backend, the transport's fetch, and the plain-data
 * views of items, tags and collections that actions.ts works on. Touches Zotero, so unit tests don't
 * import it.
 */
import { getFulltext } from "../tools/read.js";
import { collectionPath, itemSummary } from "../zotero/library.js";
import type { CollectionChoice, ItemContext } from "./actions.js";
import { type Backend, PREF_PREFIX, loadBackend, resolveModel } from "./config.js";
import type { TransportDeps } from "./transport.js";

function pref(name: string): unknown {
  return Zotero.Prefs.get(name, true);
}

/** A whole-number pref, clamped; the default if it's unset or not a number. */
export function numberPref(name: string, fallback: number, min: number, max: number): number {
  const n = Number(pref(`${PREF_PREFIX}${name}`));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

export function stringPref(name: string, fallback: string): string {
  const v = pref(`${PREF_PREFIX}${name}`);
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

export interface ActionSettings {
  backend: Backend;
  model: string;
  maxTokens: number;
  contextChars: number;
  timeoutSeconds: number;
}

export async function actionSettings(): Promise<ActionSettings> {
  const backend = await loadBackend({ pref, readFile: (path) => IOUtils.readUTF8(path) });
  return {
    backend,
    model: resolveModel(backend, stringPref("actionModel", "haiku")),
    maxTokens: numberPref("maxTokens", 4096, 256, 32_000),
    contextChars: numberPref("contextChars", 60_000, 1_000, 100_000),
    timeoutSeconds: numberPref("requestTimeoutSeconds", 120, 10, 600),
  };
}

/** fetch from the plugin's sandbox; AbortController from the main window, as the sandbox lacks one. */
export function transportDeps(): TransportDeps {
  const win = Zotero.getMainWindow();
  if (!win) throw new Error("Zotero's main window isn't open");
  return {
    fetch: (url, init) => fetch(url, init as RequestInit),
    AbortController: win.AbortController,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function pathOf(id: number): string | undefined {
  const c = Zotero.Collections.get(id);
  return c && !c.deleted ? collectionPath(c, (pid) => Zotero.Collections.get(pid)) : undefined;
}

/** The item as actions.ts sees it, with the start of its full text if it has any. */
export async function itemContext(item: ZoteroAPI.Item, contextChars: number): Promise<ItemContext> {
  const summary = itemSummary(item) as { title: string; creators?: string[]; date?: string };
  let fulltext: ItemContext["fulltext"];
  try {
    const out = await getFulltext.run({ item_key: item.key, offset: 0, max_chars: contextChars, library_id: item.libraryID });
    const data = out.data as { attachmentKey: string; totalChars: number; text: string };
    fulltext = { text: data.text, totalChars: data.totalChars, attachmentKey: data.attachmentKey };
  } catch {
    fulltext = undefined; // no readable text: the actions work from metadata
  }
  const abstract = item.isRegularItem() ? item.getField("abstractNote") : "";
  return {
    key: item.key,
    itemType: item.itemType,
    title: summary.title,
    creators: summary.creators ?? [],
    ...(summary.date ? { date: summary.date } : {}),
    ...(abstract ? { abstract } : {}),
    tags: item.getTags().map((t) => t.tag),
    collectionPaths: item.getCollections().map(pathOf).filter((p): p is string => Boolean(p)),
    ...(fulltext ? { fulltext } : {}),
  };
}

export async function libraryTags(libraryID: number): Promise<string[]> {
  return (await Zotero.Tags.getAll(libraryID)).map((t) => t.tag);
}

export function collectionChoices(libraryID: number): CollectionChoice[] {
  return Zotero.Collections.getByLibrary(libraryID, true)
    .filter((c) => !c.deleted)
    .map((c) => ({ key: c.key, path: collectionPath(c, (pid) => Zotero.Collections.get(pid)) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function collectionKeysOf(item: ZoteroAPI.Item): string[] {
  return item.getCollections().map((id) => Zotero.Collections.get(id)).flatMap((c) => (c ? [c.key] : []));
}

/** One tiny request to the configured backend: for the Settings pane's Test connection button. */
export async function testConnection(): Promise<string> {
  const { send } = await import("./transport.js");
  const settings = await actionSettings();
  const model = resolveModel(settings.backend, stringPref("chatModel", "sonnet"));
  const started = Date.now();
  const reply = await send(transportDeps(), settings.backend, { model, max_tokens: 1024, messages: [{ role: "user", content: "Reply with just: OK" }] }, { timeoutSeconds: settings.timeoutSeconds });
  return `OK: ${reply.model ?? model} via ${settings.backend.label} answered in ${((Date.now() - started) / 1000).toFixed(1)}s.`;
}

/** "KEY: title" for an item or "KEY: collection path" for a collection; undefined if it's neither. */
export function describeKey(libraryID: number, key: string): string | undefined {
  const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
  if (item) return `${key}: ${item.getDisplayTitle()}${item.deleted ? " (in the trash)" : ""}`;
  const collection = Zotero.Collections.getByLibraryAndKey(libraryID, key);
  if (collection) return `${key}: collection ${collectionPath(collection, (id) => Zotero.Collections.get(id))}`;
  return undefined;
}
