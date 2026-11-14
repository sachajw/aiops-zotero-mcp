/**
 * Lookups and plain-object views over Zotero items and collections, shared by the tools.
 * Everything that leaves the plugin goes through these views, never raw Zotero objects.
 */
import { z } from "zod";
import { ToolError } from "../mcp/tool.js";

/** Zotero keys: 8 characters from Zotero.Utilities.allowedKeyChars (no 0, 1 or O). */
export const zKey = z.string().regex(/^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/, "a Zotero key: 8 characters such as ABCD2345");

export const zLibraryID = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Library ID; omit for My Library. Group libraries: see zotero_list_libraries.");

export const zDryRun = z
  .boolean()
  .default(false)
  .describe("Report what would change without changing anything.");

export function libraryOf(libraryID: number | undefined, { write = false } = {}): number {
  const id = libraryID ?? Zotero.Libraries.userLibraryID;
  const library = Zotero.Libraries.get(id);
  if (!library) throw new ToolError(`No library with ID ${id}`);
  if (write && !library.editable) throw new ToolError(`Library "${library.name}" is read-only`);
  return id;
}

/** Trash is the only way this plugin removes anything; refuse where Zotero would erase instead. */
export function requireTrash(libraryID: number): void {
  if (!Zotero.Libraries.hasTrash(libraryID)) {
    throw new ToolError(`Library ${libraryID} has no trash, so removing would be permanent; refused`);
  }
}

export function getItem(libraryID: number, key: string): ZoteroAPI.Item {
  const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
  if (!item) throw new ToolError(`No item with key ${key} in library ${libraryID}`);
  return item;
}

export function getCollection(libraryID: number, key: string): ZoteroAPI.Collection {
  const collection = Zotero.Collections.getByLibraryAndKey(libraryID, key);
  if (!collection) throw new ToolError(`No collection with key ${key} in library ${libraryID}`);
  return collection;
}

function creatorName(c: ZoteroAPI.Creator): string {
  return c.name ?? [c.firstName, c.lastName].filter(Boolean).join(" ");
}

const LINK_MODES: Record<number, string> = {};
function linkModeName(mode: number): string {
  if (!Object.keys(LINK_MODES).length) {
    const A = Zotero.Attachments;
    LINK_MODES[A.LINK_MODE_IMPORTED_FILE] = "imported_file";
    LINK_MODES[A.LINK_MODE_IMPORTED_URL] = "imported_url";
    LINK_MODES[A.LINK_MODE_LINKED_FILE] = "linked_file";
    LINK_MODES[A.LINK_MODE_LINKED_URL] = "linked_url";
    LINK_MODES[A.LINK_MODE_EMBEDDED_IMAGE] = "embedded_image";
  }
  return LINK_MODES[mode] ?? String(mode);
}

/** One line per item in lists. */
export function itemSummary(item: ZoteroAPI.Item): Record<string, unknown> {
  const base: Record<string, unknown> = {
    key: item.key,
    itemType: item.itemType,
    title: item.getDisplayTitle(),
  };
  if (item.isRegularItem()) {
    const creators = item.getCreators().map(creatorName).filter(Boolean);
    if (creators.length) base.creators = creators;
    const date = item.getField("date");
    if (date) base.date = date;
    base.attachments = item.getAttachments().length;
    base.notes = item.getNotes().length;
  }
  if (item.isAttachment()) {
    base.filename = item.attachmentFilename || undefined;
    base.contentType = item.attachmentContentType || undefined;
  }
  if (item.parentKey) base.parentKey = item.parentKey;
  if (item.deleted) base.inTrash = true;
  return base;
}

/** Everything about one item, for zotero_get_item. */
export async function itemDetail(item: ZoteroAPI.Item): Promise<Record<string, unknown>> {
  const json = item.toJSON();
  delete json.relations;
  const detail: Record<string, unknown> = {
    ...json,
    key: item.key,
    libraryID: item.libraryID,
    collectionKeys: collectionKeysOf(item),
    inTrash: item.deleted,
  };
  delete detail.collections;
  if (item.isRegularItem()) {
    detail.attachments = await Promise.all(
      Zotero.Items.get(item.getAttachments()).map(attachmentView),
    );
    detail.notes = Zotero.Items.get(item.getNotes()).map((n) => ({ key: n.key, text: noteText(n.getNote()) }));
  }
  if (item.isAttachment()) {
    Object.assign(detail, await attachmentView(item));
  }
  return detail;
}

/** Collection keys for an item, resolved from its collection IDs. */
function collectionKeysOf(item: ZoteroAPI.Item): string[] {
  const all = Zotero.Collections.getByLibrary(item.libraryID, true);
  const byId = new Map(all.map((c) => [c.id, c.key]));
  return item.getCollections().map((id) => byId.get(id)).filter((k): k is string => Boolean(k));
}

export async function attachmentView(att: ZoteroAPI.Item): Promise<Record<string, unknown>> {
  const path = await att.getFilePathAsync();
  return {
    key: att.key,
    title: att.getField("title"),
    filename: att.attachmentFilename || null,
    contentType: att.attachmentContentType || null,
    linkMode: linkModeName(att.attachmentLinkMode),
    fileExists: path ? await IOUtils.exists(path) : false,
    inTrash: att.deleted,
  };
}

export function collectionView(c: ZoteroAPI.Collection): Record<string, unknown> {
  return {
    key: c.key,
    name: c.name,
    parentKey: c.parentKey || null,
    items: c.getChildItems().length,
    subcollections: c.getChildCollections().length,
  };
}

/** Notes are HTML; return readable text. */
export function noteText(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, "\n");
  return Zotero.Utilities.unescapeHTML(withBreaks.replace(/<[^>]+>/g, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plain text → note HTML, escaping markup. */
export function textToNoteHtml(text: string): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escape(para).replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
}

export function dryRunResult(summary: string, plan: unknown) {
  return { summary: `Dry run, nothing changed. ${summary}`, data: plan };
}
