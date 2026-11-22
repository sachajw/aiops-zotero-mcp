/**
 * Zotero-side glue for the assistant: prefs, the backend, the transport's fetch, and the plain-data
 * views of items, tags and collections that actions.ts works on. Touches Zotero, so unit tests don't
 * import it.
 */
import { getFulltext } from "../tools/read.js";
import { collectionPath, itemSummary } from "../zotero/library.js";
import type { CollectionChoice, ItemContext, RelatedCandidate } from "./actions.js";
import {
  ACTIVE_PROFILE_PREF,
  BACKENDS_PREF,
  type Backend,
  type ConfigReader,
  type ModelUse,
  PREF_PREFIX,
  PROFILE_FILES_PREF,
  PROVIDERS,
  backendLabels,
  isLoopback,
  loadBackend,
  modelChoice,
  parseStoredBackends,
  profileFiles,
  profileLabel,
  resolveModel,
  validateStoredBackend,
} from "./config.js";
import type { TransportDeps } from "./transport.js";

function pref(name: string): unknown {
  return Zotero.Prefs.get(name, true);
}

/** A whole-number pref, clamped; the default if it's unset or not a number. */
export function numberPref(name: string, fallback: number, min: number, max: number): number {
  const n = Number(pref(`${PREF_PREFIX}${name}`));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

const MODEL_DEFAULTS: Record<ModelUse, string> = { chatModel: "sonnet", actionModel: "sonnet" };

/** The model ID for a use on this backend (per-backend pref, shared pref, then default tier). */
export function modelFor(backend: Backend, use: ModelUse): string {
  return resolveModel(backend, modelChoice(pref, use, backend.label, MODEL_DEFAULTS[use]));
}

// ---------------------------------------------------------------- API keys

/**
 * Keys for providers added in Settings live in Zotero's password store (Firefox's login manager),
 * under this origin with the provider's name as the realm: never in prefs. The store is encrypted
 * at rest; it's protected by a password only if the user sets a primary password.
 */
const KEY_ORIGIN = "chrome://aiops-zotero-mcp";
const KEY_USER = "api-key";

export const keyStore = {
  async read(name: string): Promise<string | undefined> {
    const found = await Services.logins.searchLoginsAsync({ origin: KEY_ORIGIN, httpRealm: name });
    return found[0]?.password || undefined;
  },
  async remove(name: string): Promise<void> {
    const found = await Services.logins.searchLoginsAsync({ origin: KEY_ORIGIN, httpRealm: name });
    // Zotero 11 (Firefox 153) replaces removeLogin with removeLoginAsync; Zotero 10 has only removeLogin.
    for (const login of found) {
      if (Services.logins.removeLoginAsync) await Services.logins.removeLoginAsync(login);
      else Services.logins.removeLogin?.(login);
    }
  },
  async write(name: string, key: string): Promise<void> {
    await this.remove(name);
    const LoginInfo = Components.Constructor("@mozilla.org/login-manager/loginInfo;1", Ci.nsILoginInfo, "init");
    await Services.logins.addLoginAsync(new LoginInfo(KEY_ORIGIN, null, name, KEY_USER, key, "", ""));
  },
};

const reader: ConfigReader = { pref, readFile: (path) => IOUtils.readUTF8(path), readKey: (name) => keyStore.read(name) };

// --------------------------------------------------- backends (Settings pane API)

export interface BackendInfo {
  name: string;
  source: "file" | "settings";
  /** The file path, or the provider's base URL. */
  where: string;
  active: boolean;
}

export function listBackends(): BackendInfo[] {
  const labels = backendLabels(pref(PROFILE_FILES_PREF), pref(BACKENDS_PREF));
  const active = String(pref(ACTIVE_PROFILE_PREF) ?? "").trim() || labels[0];
  const files = profileFiles(pref(PROFILE_FILES_PREF)).map((f) => ({ name: profileLabel(f), source: "file" as const, where: f }));
  const stored = parseStoredBackends(pref(BACKENDS_PREF)).map((b) => ({ name: b.name, source: "settings" as const, where: b.baseURL }));
  return [...files, ...stored].map((b) => ({ ...b, active: b.name === active }));
}

/** Save a provider from the Settings form: its settings to prefs, its key to the password store. */
export async function saveBackend(input: { name: unknown; baseURL: unknown; auth: unknown; models: unknown; key: unknown; format?: unknown; tokenParam?: unknown }): Promise<string> {
  const stored = parseStoredBackends(pref(BACKENDS_PREF));
  const taken = backendLabels(pref(PROFILE_FILES_PREF), "[]");
  const def = validateStoredBackend(
    { name: input.name, baseURL: input.baseURL, auth: input.auth, models: input.models, format: input.format || undefined, tokenParam: input.tokenParam || undefined },
    [...taken, ...stored.map((b) => b.name)],
  );
  const key = typeof input.key === "string" ? input.key.trim() : "";
  if (key) await keyStore.write(def.name, key);
  else if (!isLoopback(def.baseURL)) throw new Error("Enter the API key (only a gateway on this computer can do without one)");
  else await keyStore.remove(def.name);
  Zotero.Prefs.set(BACKENDS_PREF, JSON.stringify([...stored, def]), true);
  return key ? `Saved ${def.name}. Its key is in Zotero's password store.` : `Saved ${def.name}, without a key (the gateway signs in by itself).`;
}

export async function removeBackend(name: string): Promise<void> {
  const stored = parseStoredBackends(pref(BACKENDS_PREF));
  Zotero.Prefs.set(BACKENDS_PREF, JSON.stringify(stored.filter((b) => b.name !== name)), true);
  await keyStore.remove(name);
  if (String(pref(ACTIVE_PROFILE_PREF) ?? "") === name) Zotero.Prefs.set(ACTIVE_PROFILE_PREF, "", true);
}

export function providers(): typeof PROVIDERS {
  return PROVIDERS;
}

export interface ActionSettings {
  backend: Backend;
  model: string;
  maxTokens: number;
  contextChars: number;
  timeoutSeconds: number;
}

export async function actionSettings(): Promise<ActionSettings> {
  const backend = await loadBackend(reader);
  return {
    backend,
    model: modelFor(backend, "actionModel"),
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
export async function testConnection(name?: string): Promise<string> {
  const { send } = await import("./transport.js");
  const backend = await loadBackend(reader, name);
  const model = modelFor(backend, "chatModel");
  const started = Date.now();
  const reply = await send(transportDeps(), backend, { model, max_tokens: 1024, messages: [{ role: "user", content: "Reply with just: OK" }] }, { timeoutSeconds: numberPref("requestTimeoutSeconds", 120, 10, 600) });
  return `OK: ${reply.model ?? model} via ${backend.label} answered in ${((Date.now() - started) / 1000).toFixed(1)}s.`;
}

/** "KEY: title" for an item or "KEY: collection path" for a collection; undefined if it's neither. */
export function describeKey(libraryID: number, key: string): string | undefined {
  const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
  if (item) return `${key}: ${item.getDisplayTitle()}${item.deleted ? " (in the trash)" : ""}`;
  const collection = Zotero.Collections.getByLibraryAndKey(libraryID, key);
  if (collection) return `${key}: collection ${collectionPath(collection, (id) => Zotero.Collections.get(id))}`;
  return undefined;
}

/**
 * Saved conversations, in "aiops-zotero-mcp/chats" inside Zotero's data directory (next to
 * zotero.sqlite, never synced). Names come from store.ts's storeFileName, so they're always plain
 * file names.
 */
export const chatStore = {
  dir(): string {
    return PathUtils.join(Zotero.DataDirectory.dir, "aiops-zotero-mcp", "chats");
  },
  async read(name: string): Promise<string | undefined> {
    const path = PathUtils.join(this.dir(), name);
    return (await IOUtils.exists(path)) ? IOUtils.readUTF8(path) : undefined;
  },
  async write(name: string, json: string): Promise<void> {
    await IOUtils.makeDirectory(this.dir(), { createAncestors: true, ignoreExisting: true });
    const path = PathUtils.join(this.dir(), name);
    await IOUtils.writeUTF8(path, json, { tmpPath: `${path}.tmp` });
  },
  async remove(name: string): Promise<void> {
    await IOUtils.remove(PathUtils.join(this.dir(), name), { ignoreAbsent: true });
  },
};

/**
 * Candidates for "Suggest related items": regular items in the same collections, sharing a tag, or
 * matching the title's distinctive words; not the item itself or anything already related. Items
 * matching more of these come first.
 */
export async function relatedCandidates(item: ZoteroAPI.Item): Promise<RelatedCandidate[]> {
  const { titleWords, MAX_RELATED_CANDIDATES } = await import("./actions.js");
  const reasons = new Map<number, string[]>();
  const note = (id: number, why: string) => {
    if (id === item.id) return;
    const list = reasons.get(id) ?? [];
    if (!list.includes(why)) list.push(why);
    reasons.set(id, list);
  };
  for (const collectionID of item.getCollections()) {
    const c = Zotero.Collections.get(collectionID);
    if (!c) continue;
    for (const other of c.getChildItems()) if (other.isRegularItem()) note(other.id, `same collection: ${c.name}`);
  }
  const search = async (condition: string, value: string, why: string) => {
    const s = new Zotero.Search();
    s.libraryID = item.libraryID;
    s.addCondition(condition, condition === "tag" ? "is" : "contains", value);
    s.addCondition("noChildren", "true");
    for (const id of (await s.search()).slice(0, 60)) note(id, why);
  };
  for (const { tag } of item.getTags().slice(0, 10)) await search("tag", tag, `tag: ${tag}`);
  for (const word of titleWords(item.getDisplayTitle())) await search("quicksearch-titleCreatorYear", word, `title word: ${word}`);
  const related = new Set(item.relatedItems);
  const ranked = [...reasons].sort((a, b) => b[1].length - a[1].length).slice(0, MAX_RELATED_CANDIDATES * 2);
  const items = await Zotero.Items.getAsync(ranked.map(([id]) => id));
  return items
    .filter((o) => o.isRegularItem() && !o.deleted && !related.has(o.key))
    .slice(0, MAX_RELATED_CANDIDATES)
    .map((o) => ({ key: o.key, title: o.getDisplayTitle(), why: (reasons.get(o.id) ?? []).slice(0, 3).join("; ") }));
}
