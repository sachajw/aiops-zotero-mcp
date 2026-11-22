import { z } from "zod";
import { ToolError, defineTool } from "../mcp/tool.js";
import {
  attachmentView,
  count,
  collectionView,
  dryRunResult,
  getCollection,
  getItem,
  itemSummary,
  libraryOf,
  requireTrash,
  textToNoteHtml,
  zDryRun,
  zKey,
  zLibraryID,
} from "../zotero/library.js";
import { suspender } from "../zotero/suspend.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const WRITE_IDEMPOTENT = { ...WRITE, idempotentHint: true };

const zKeys = z.array(zKey).min(1).max(100);

const zCreator = z.union([
  z.object({
    creator_type: z.string().min(1).describe('e.g. "author", "editor"'),
    first_name: z.string().default(""),
    last_name: z.string().min(1),
  }),
  z.object({
    creator_type: z.string().min(1),
    name: z.string().min(1).describe("Single-field name, e.g. an organisation"),
  }),
]);

/** Check field names and creator types against Zotero's schema before touching the item. */
function validateItemData(
  itemType: string,
  fields: Record<string, string> | undefined,
  creators: Array<z.infer<typeof zCreator>> | undefined,
): void {
  const typeID = Zotero.ItemTypes.getID(itemType);
  if (!typeID) throw new ToolError(`Unknown item type: ${itemType}`);
  const badFields = Object.keys(fields ?? {}).filter((f) => {
    const id = Zotero.ItemFields.getID(f);
    return !id || !Zotero.ItemFields.isValidForType(id, typeID);
  });
  if (badFields.length) {
    const valid = Zotero.ItemFields.getItemTypeFields(typeID).map((id) => Zotero.ItemFields.getName(id));
    throw new ToolError(`Not fields of ${itemType}: ${badFields.join(", ")}. Valid: ${valid.join(", ")}`);
  }
  const validCreatorTypes = Zotero.CreatorTypes.getTypesForItemType(typeID).map((t) => t.name);
  const badCreators = (creators ?? []).filter((c) => !validCreatorTypes.includes(c.creator_type));
  if (badCreators.length) {
    throw new ToolError(
      `Creator types not valid for ${itemType}: ${badCreators.map((c) => c.creator_type).join(", ")}. Valid: ${validCreatorTypes.join(", ")}`,
    );
  }
}

function toZoteroCreators(creators: Array<z.infer<typeof zCreator>>): ZoteroAPI.Creator[] {
  return creators.map((c) =>
    "name" in c
      ? { creatorType: c.creator_type, name: c.name }
      : { creatorType: c.creator_type, firstName: c.first_name, lastName: c.last_name },
  );
}

/**
 * An entry for Zotero's Edit → Undo (Zotero 10+): one of Zotero's own undo-action-* Fluent IDs and
 * its arguments. Creating objects isn't undoable in Zotero, so creation tools don't take one.
 */
export interface UndoLabel {
  action: string;
  args?: Record<string, string | number>;
}

/** Collection membership changes, labelled the way Zotero labels the same change made by hand. */
export function collectionUndo(itemCount: number, adding: number, removing: number): UndoLabel {
  const action = adding && removing ? "undo-action-move-to-collection" : adding ? "undo-action-add-to-collection" : "undo-action-remove-from-collection";
  return { action, args: { count: itemCount } };
}

export function tagUndo(itemCount: number, adding: number, removing: number): UndoLabel {
  if (adding && removing) return { action: "undo-action-change-tag" };
  return { action: adding ? "undo-action-add-tag" : "undo-action-remove-tag", args: { count: itemCount } };
}

/**
 * Run changes in one DB transaction that Zotero records as a single undo step: a failure rolls back
 * all of them, and Edit → Undo reverses all of them. Saves inside must use save(), not saveTx().
 */
async function undoable(label: UndoLabel, change: () => Promise<void>): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    Zotero.UndoHistory.stageAction(label.action, label.args);
    await change();
  });
}

/** Apply a change to every item and save them as one undoable, all-or-nothing step. */
async function saveAllOrNone(items: ZoteroAPI.Item[], label: UndoLabel, change: (item: ZoteroAPI.Item) => void): Promise<void> {
  await undoable(label, async () => {
    for (const item of items) {
      change(item);
      await item.save();
    }
  });
}

function topLevel(item: ZoteroAPI.Item, what: string): void {
  if (item.parentKey) throw new ToolError(`${item.key} is a child item (of ${item.parentKey}); ${what} applies to top-level items`);
}

// ---------------------------------------------------------------- collections

export const createCollection = defineTool({
  name: "zotero_create_collection",
  title: "Create collection",
  description: "Create a collection, at the top level or inside parent_key.",
  input: z.object({
    name: z.string().trim().min(1).max(255),
    parent_key: zKey.optional(),
    dry_run: zDryRun,
    library_id: zLibraryID,
  }),
  annotations: WRITE,
  async run(args) {
    const libraryID = libraryOf(args.library_id, { write: true });
    const parent = args.parent_key ? getCollection(libraryID, args.parent_key) : undefined;
    const plan = { name: args.name, parentKey: parent?.key ?? null, libraryID };
    if (args.dry_run) return dryRunResult(`Would create collection "${args.name}"`, plan);
    const collection = new Zotero.Collection();
    collection.libraryID = libraryID;
    collection.name = args.name;
    if (parent) collection.parentKey = parent.key;
    await collection.saveTx();
    return { summary: `Created collection ${collection.key} "${collection.name}"`, data: collectionView(collection) };
  },
});

export const updateCollection = defineTool({
  name: "zotero_update_collection",
  title: "Rename or move collection",
  description: "Rename a collection and/or move it under another parent (parent_key null moves it to the top level).",
  input: z.object({
    collection_key: zKey,
    name: z.string().trim().min(1).max(255).optional(),
    parent_key: zKey.nullable().optional().describe("New parent; null for top level; omit to keep."),
    dry_run: zDryRun,
    library_id: zLibraryID,
  }),
  annotations: WRITE_IDEMPOTENT,
  async run(args) {
    const libraryID = libraryOf(args.library_id, { write: true });
    if (args.name === undefined && args.parent_key === undefined) throw new ToolError("Nothing to change: give name and/or parent_key");
    const collection = getCollection(libraryID, args.collection_key);
    if (args.parent_key) {
      if (args.parent_key === collection.key) throw new ToolError("A collection can't be its own parent");
      // Refuse moving a collection under one of its own descendants.
      const descendants = Zotero.Collections.getByParent(collection.id, true).map((c) => c.key);
      if (descendants.includes(args.parent_key)) throw new ToolError(`${args.parent_key} is inside ${collection.key}; that would make a loop`);
      getCollection(libraryID, args.parent_key);
    }
    const before = { name: collection.name, parentKey: collection.parentKey || null };
    const after = {
      name: args.name ?? collection.name,
      parentKey: args.parent_key === undefined ? before.parentKey : args.parent_key,
    };
    if (args.dry_run) return dryRunResult(`Would update collection ${collection.key}`, { before, after });
    if (args.name !== undefined) collection.name = args.name;
    if (args.parent_key !== undefined) collection.parentKey = args.parent_key ?? false;
    const renamed = after.name !== before.name;
    await undoable({ action: renamed ? "undo-action-rename-collection" : "undo-action-move-collection" }, async () => {
      await collection.save();
    });
    return { summary: `Updated collection ${collection.key}`, data: { before, after: collectionView(collection) } };
  },
});

// ---------------------------------------------------------------------- items

export const createItem = defineTool({
  name: "zotero_create_item",
  title: "Create item",
  description:
    'Create a regular item (book, journalArticle, report, webpage, ...) with fields such as {"title": "...", "date": "2024"}. ' +
    "Field names and creator types are checked against Zotero's schema; a wrong one is reported with the valid list.",
  input: z.object({
    item_type: z.string().min(1),
    fields: z.record(z.string(), z.string()).default({}),
    creators: z.array(zCreator).max(500).optional(),
    tags: z.array(z.string().min(1)).max(100).optional(),
    collection_keys: z.array(zKey).max(50).optional(),
    dry_run: zDryRun,
    library_id: zLibraryID,
  }),
  annotations: WRITE,
  async run(args) {
    const libraryID = libraryOf(args.library_id, { write: true });
    if (["attachment", "note", "annotation"].includes(args.item_type)) {
      throw new ToolError(`Use zotero_add_file for attachments and zotero_add_note for notes`);
    }
    validateItemData(args.item_type, args.fields, args.creators);
    const collections = (args.collection_keys ?? []).map((k) => getCollection(libraryID, k));
    const plan = { itemType: args.item_type, fields: args.fields, creators: args.creators, tags: args.tags, collectionKeys: collections.map((c) => c.key) };
    if (args.dry_run) return dryRunResult(`Would create a ${args.item_type}`, plan);
    const item = new Zotero.Item(args.item_type);
    item.libraryID = libraryID;
    for (const [field, value] of Object.entries(args.fields)) item.setField(field, value);
    if (args.creators) item.setCreators(toZoteroCreators(args.creators));
    for (const tag of args.tags ?? []) item.addTag(tag);
    for (const c of collections) item.addToCollection(c.id);
    await item.saveTx();
    return { summary: `Created ${item.itemType} ${item.key}`, data: itemSummary(item) };
  },
});

export const updateItem = defineTool({
  name: "zotero_update_item",
  title: "Update item",
  description:
    'Change fields of an item (an empty string clears a field) and/or replace its creator list. For an attachment, "title" is its title; use zotero_rename_attachment to rename the file.',
  input: z.object({
    item_key: zKey,
    fields: z.record(z.string(), z.string()).optional(),
    creators: z.array(zCreator).max(500).optional().describe("Replaces all creators."),
    dry_run: zDryRun,
    library_id: zLibraryID,
  }),
  annotations: WRITE_IDEMPOTENT,
  async run(args) {
    const libraryID = libraryOf(args.library_id, { write: true });
    if (!args.fields && !args.creators) throw new ToolError("Nothing to change: give fields and/or creators");
    const item = getItem(libraryID, args.item_key);
    if (item.isNote() || item.isAnnotation()) throw new ToolError(`${item.key} is a ${item.itemType}; it has no fields to update`);
    validateItemData(item.itemType, args.fields, args.creators);
    const changes = Object.entries(args.fields ?? {})
      .map(([field, to]) => ({ field, from: item.getField(field), to }))
      .filter((c) => c.from !== c.to);
    const plan = { changes, creators: args.creators ? { from: item.getCreators(), to: toZoteroCreators(args.creators) } : undefined };
    if (args.dry_run) return dryRunResult(`Would update ${item.key}`, plan);
    for (const c of changes) item.setField(c.field, c.to);
    if (args.creators) item.setCreators(toZoteroCreators(args.creators));
    await undoable({ action: "undo-action-edit-metadata", args: { count: 1 } }, async () => {
      await item.save();
    });
    return { summary: `Updated ${item.key} (${changes.length} field changes${args.creators ? ", creators replaced" : ""})`, data: plan };
  },
});

// ---------------------------------------------------------------- attachments

/**
 * Auto-recognition off while adding, so Zotero doesn't wrap the PDF in a guessed parent item.
 * Shared across overlapping zotero_add_file calls, so the user's setting comes back after the last.
 */
const AUTO_RECOGNIZE_PREF = "extensions.zotero.autoRecognizeFiles";
const withoutAutoRecognize = suspender(
  () => Zotero.Prefs.get(AUTO_RECOGNIZE_PREF, true),
  (v) => Zotero.Prefs.set(AUTO_RECOGNIZE_PREF, v, true),
  false,
);

export const addFile = defineTool({
  name: "zotero_add_file",
  title: "Add file",
  description:
    "Add a file from this computer as an attachment: stored in Zotero (import, the default) or linked in place (link). " +
    "Standalone in collection_keys, or under parent_item_key. Zotero's automatic metadata retrieval is not triggered.",
  input: z.object({
    path: z.string().min(1).describe("Absolute path to the file."),
    mode: z.enum(["import", "link"]).default("import"),
    title: z.string().trim().min(1).max(500).optional().describe("Attachment title; defaults to the file name."),
    parent_item_key: zKey.optional(),
    collection_keys: z.array(zKey).max(50).optional().describe("Collections for a standalone attachment."),
    dry_run: zDryRun,
    library_id: zLibraryID,
  }),
  annotations: WRITE,
  async run(args) {
    const libraryID = libraryOf(args.library_id, { write: true });
    if (!PathUtils.isAbsolute(args.path)) throw new ToolError(`Path must be absolute: ${args.path}`);
    if (!(await IOUtils.exists(args.path))) throw new ToolError(`No file at ${args.path}`);
    const stat = await IOUtils.stat(args.path);
    if (stat.type !== "regular") throw new ToolError(`Not a regular file: ${args.path}`);
    if (args.parent_item_key && args.collection_keys?.length) {
      throw new ToolError("A child attachment can't be in collections; give parent_item_key or collection_keys, not both");
    }
    const parent = args.parent_item_key ? getItem(libraryID, args.parent_item_key) : undefined;
    if (parent && !parent.isRegularItem()) throw new ToolError(`${parent.key} is a ${parent.itemType}; attachments go under regular items`);
    if (args.mode === "link" && libraryID !== Zotero.Libraries.userLibraryID) {
      throw new ToolError("Linked files are only supported in My Library");
    }
    const collections = (args.collection_keys ?? []).map((k) => getCollection(libraryID, k));
    const title = args.title ?? PathUtils.filename(args.path);
    const plan = { path: args.path, mode: args.mode, title, bytes: stat.size, parentKey: parent?.key ?? null, collectionKeys: collections.map((c) => c.key) };
    if (args.dry_run) return dryRunResult(`Would ${args.mode} ${PathUtils.filename(args.path)}`, plan);

    const common = {
      file: args.path,
      title,
      ...(parent ? { parentItemID: parent.id } : { collections: collections.map((c) => c.id) }),
    };
    const attachment = await withoutAutoRecognize(() =>
      args.mode === "import"
        ? Zotero.Attachments.importFromFile({ ...common, libraryID })
        : Zotero.Attachments.linkFromFile(common),
    );
    return { summary: `Added ${attachment.key}`, data: await attachmentView(attachment) };
  },
});

/** Why Zotero's recogniser would skip this item, mirroring Zotero.RecognizeDocument.canRecognize; null if it can take it. */
function unrecognizableReason(item: ZoteroAPI.Item): string | null {
  if (!item.isAttachment()) return `is a ${item.itemType}, not an attachment`;
  if (!item.isPDFAttachment() && !item.isEPUBAttachment()) return "is not a PDF or EPUB";
  if (!item.isTopLevelItem()) return `already has a parent (${String(item.parentKey)})`;
  if (item.deleted) return "is in the trash";
  return null;
}

/** Zotero.ProgressQueue row statuses (xpcom/progressQueue.js). */
const ROW_QUEUED = 1;
const ROW_PROCESSING = 2;

/**
 * What an attachment without a new parent ended up as. Its row in Zotero's progress queue has a
 * final status and message once Zotero is done with it; a row still queued or processing is
 * pending, unless the whole run already failed, in which case nothing will finish it.
 */
export function unfinishedOutcome(
  row: { status: number; message?: string } | undefined,
  failure: { error: unknown } | undefined,
): { status: "not_recognized" | "failed" | "pending"; reason: string } {
  if (row && row.status !== ROW_QUEUED && row.status !== ROW_PROCESSING) {
    return { status: "not_recognized", reason: row.message || "no match found" };
  }
  if (failure) {
    const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
    return { status: "failed", reason: `Zotero's metadata retrieval stopped with an error: ${message}. Retry with zotero_retrieve_metadata` };
  }
  return { status: "pending", reason: "still running in Zotero; check later with zotero_get_item" };
}

export const RETRIEVE_WAIT_PREF = "extensions.aiops-zotero-mcp.retrieveMetadataWaitSeconds";

/** How long zotero_retrieve_metadata waits before reporting the rest as pending; must stay under the MCP client's tool timeout. */
export function parseWaitSeconds(raw: unknown): number {
  const n = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ToolError(`${RETRIEVE_WAIT_PREF} must be a whole number of seconds ≥ 1 (got ${String(raw)})`);
  return n;
}

export const retrieveMetadata = defineTool({
  name: "zotero_retrieve_metadata",
  title: "Retrieve metadata for PDFs/EPUBs",
  description:
    "Run Zotero's own \"Retrieve Metadata for PDF\" on standalone PDF or EPUB attachments: Zotero sends text from the first pages " +
    "to its metadata service (zotero.org), looks up the DOI/ISBN/arXiv ID it finds, creates a parent item in the attachment's collections " +
    "and moves the attachment under it. The file may be renamed to match, per your Zotero file-renaming setting. " +
    "Reports, per attachment, the new parent, why nothing was found, or 'pending' if Zotero is still working on it when the wait " +
    "(extensions.aiops-zotero-mcp.retrieveMetadataWaitSeconds, 45 by default) runs out; pending ones finish in Zotero, so check them later " +
    "with zotero_get_item rather than resubmitting. To undo, use the undo entry on the new parent's context menu in Zotero " +
    "(offered for 24 hours, until the parent is edited or Zotero restarts); trashing the parent would trash the attachment with it.",
  input: z.object({
    item_keys: z.array(zKey).min(1).max(50).describe("Standalone PDF/EPUB attachment keys."),
    dry_run: zDryRun,
    library_id: zLibraryID,
  }),
  annotations: { ...WRITE, openWorldHint: true },
  async run(args) {
    const libraryID = libraryOf(args.library_id, { write: true });
    const items = args.item_keys.map((k) => getItem(libraryID, k));
    const refused = items.flatMap((i) => {
      const reason = unrecognizableReason(i);
      return reason ? [`${i.key} ${reason}`] : [];
    });
    if (refused.length) throw new ToolError(`Can't retrieve metadata: ${refused.join("; ")}`);
    const plan = items.map(itemSummary);
    if (args.dry_run) return dryRunResult(`Would retrieve metadata for ${count(items.length, "attachment")}`, plan);
    // Zotero's queue waits (re-checking every minute) while offline; refuse instead of hanging the call.
    if (Zotero.HTTP.browserIsOffline()) throw new ToolError("Zotero is offline; metadata retrieval needs zotero.org");

    // Zotero's queue keeps going after we stop waiting, so a slow lookup (big PDF, throttled ISBN
    // catalogue) can't hold the call past the client's timeout: report what's done, the rest as pending.
    const waitSeconds = parseWaitSeconds(Zotero.Prefs.get(RETRIEVE_WAIT_PREF, true));
    // Settle rather than throw: a failure mid-run must still report what each attachment ended up as.
    let failure: { error: unknown } | undefined;
    const recognizing = Zotero.RecognizeDocument.recognizeItems(items).catch((error: unknown) => {
      failure = { error };
      Zotero.logError(error);
    });
    await Promise.race([recognizing, Zotero.Promise.delay(waitSeconds * 1000)]);

    // recognizeItems logs failures rather than throwing; the outcome is whether a parent now exists,
    // and the reason for a miss is the message on the item's row in Zotero's progress queue.
    const rows = Zotero.ProgressQueues.get("recognize")?.getRows() ?? [];
    const results = await Promise.all(items.map(async (before) => {
      const att = getItem(libraryID, before.key);
      if (att.parentItemID) {
        const parent = getItem(libraryID, String(att.parentKey));
        return { key: att.key, status: "recognized", parent: itemSummary(parent), attachment: await attachmentView(att) };
      }
      return { key: att.key, ...unfinishedOutcome(rows.find((r) => r.id === att.id), failure) };
    }));
    const tally = (s: string) => results.filter((r) => r.status === s).length;
    const pending = tally("pending");
    return {
      summary:
        `Retrieved metadata for ${tally("recognized")} of ${count(items.length, "attachment")}` +
        (pending ? `; ${pending} still running in Zotero after ${waitSeconds}s` : "") +
        (tally("failed") ? `; ${tally("failed")} stopped by an error in Zotero's metadata retrieval` : ""),
      data: results,
    };
  },
});

export const renameAttachment = defineTool({
  name: "zotero_rename_attachment",
  title: "Rename attachment",
  description:
    "Change an attachment's title and/or its file name on disk. If filename has no extension, the current one is kept. Fails rather than overwriting an existing file.",
  input: z.object({
    item_key: zKey,
    title: z.string().trim().min(1).max(500).optional(),
    filename: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .refine((s) => !/[/\\:\0]/.test(s), "no path separators, colons or NUL")
      .optional(),
    dry_run: zDryRun,
    library_id: zLibraryID,
  }),
  annotations: WRITE_IDEMPOTENT,
  async run(args) {
    const libraryID = libraryOf(args.library_id, { write: true });
    if (!args.title && !args.filename) throw new ToolError("Nothing to change: give title and/or filename");
    const att = getItem(libraryID, args.item_key);
    if (!att.isAttachment()) throw new ToolError(`${att.key} is a ${att.itemType}, not an attachment`);
    let filename = args.filename;
    if (filename) {
      if (att.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) throw new ToolError(`${att.key} is a link to a URL; it has no file`);
      const current = att.attachmentFilename;
      const ext = current.includes(".") ? current.slice(current.lastIndexOf(".")) : "";
      if (!filename.includes(".") && ext) filename += ext;
    }
    const before = { title: att.getField("title"), filename: att.attachmentFilename };
    const after = { title: args.title ?? before.title, filename: filename ?? before.filename };
    if (args.dry_run) return dryRunResult(`Would rename ${att.key}`, { before, after });

    if (filename && filename !== before.filename) {
      const result = await att.renameAttachmentFile(filename, { overwrite: false, unique: false, updateTitle: false });
      if (result === -1) throw new ToolError(`A file named ${filename} already exists next to this attachment`);
      if (result !== true) throw new ToolError(`Zotero could not rename the file (result ${String(result)}); does the file exist?`);
    }
    if (args.title && args.title !== before.title) {
      att.setField("title", args.title);
      try {
        await undoable({ action: "undo-action-edit-field", args: { count: 1, field: "Title" } }, async () => {
          await att.save();
        });
      } catch (error) {
        if (filename && filename !== before.filename) {
          // The file is already renamed on disk; say so, or the caller assumes nothing changed.
          const why = error instanceof Error ? error.message : String(error);
          throw new ToolError(`Renamed the file to ${filename}, but saving the new title failed (${why}); the title is still "${before.title}"`);
        }
        throw error;
      }
    }
    return { summary: `Renamed ${att.key}`, data: { before, after: await attachmentView(att) } };
  },
});

// ------------------------------------------------------- collections and tags

export const setCollections = defineTool({
  name: "zotero_set_collections",
  title: "Add to or remove from collections",
  description: "Add items to collections and/or remove them. Items stay in the library; removing only takes them out of a collection.",
  input: z.object({
    item_keys: zKeys,
    add: z.array(zKey).max(50).default([]),
    remove: z.array(zKey).max(50).default([]),
    dry_run: zDryRun,
    library_id: zLibraryID,
  }),
  annotations: WRITE_IDEMPOTENT,
  async run(args) {
    const libraryID = libraryOf(args.library_id, { write: true });
    if (!args.add.length && !args.remove.length) throw new ToolError("Nothing to change: give add and/or remove");
    const overlap = args.add.filter((k) => args.remove.includes(k));
    if (overlap.length) throw new ToolError(`In both add and remove: ${overlap.join(", ")}`);
    const items = args.item_keys.map((k) => getItem(libraryID, k));
    items.forEach((i) => topLevel(i, "collection membership"));
    const add = args.add.map((k) => getCollection(libraryID, k));
    const remove = args.remove.map((k) => getCollection(libraryID, k));
    const plan = { items: items.map((i) => i.key), add: add.map((c) => `${c.key} ${c.name}`), remove: remove.map((c) => `${c.key} ${c.name}`) };
    if (args.dry_run) return dryRunResult(`Would change collections of ${count(items.length, "item")}`, plan);
    await saveAllOrNone(items, collectionUndo(items.length, add.length, remove.length), (item) => {
      add.forEach((c) => item.addToCollection(c.id));
      remove.forEach((c) => item.removeFromCollection(c.id));
    });
    return { summary: `Updated collections of ${count(items.length, "item")}`, data: plan };
  },
});

export const setTags = defineTool({
  name: "zotero_set_tags",
  title: "Add or remove tags",
  description: "Add and/or remove tags on items.",
  input: z.object({
    item_keys: zKeys,
    add: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
    remove: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
    dry_run: zDryRun,
    library_id: zLibraryID,
  }),
  annotations: WRITE_IDEMPOTENT,
  async run(args) {
    const libraryID = libraryOf(args.library_id, { write: true });
    if (!args.add.length && !args.remove.length) throw new ToolError("Nothing to change: give add and/or remove");
    const items = args.item_keys.map((k) => getItem(libraryID, k));
    const plan = { items: items.map((i) => i.key), add: args.add, remove: args.remove };
    if (args.dry_run) return dryRunResult(`Would change tags on ${count(items.length, "item")}`, plan);
    await saveAllOrNone(items, tagUndo(items.length, args.add.length, args.remove.length), (item) => {
      args.add.forEach((t) => item.addTag(t));
      args.remove.forEach((t) => item.removeTag(t));
    });
    return { summary: `Updated tags on ${count(items.length, "item")}`, data: plan };
  },
});

// ---------------------------------------------------------------------- notes

export const addNote = defineTool({
  name: "zotero_add_note",
  title: "Add note",
  description: "Add a note: a child note under parent_item_key, or a standalone note (optionally in collections). Text is plain text unless format is html.",
  input: z.object({
    text: z.string().min(1).max(200_000),
    format: z.enum(["text", "html"]).default("text"),
    parent_item_key: zKey.optional(),
    collection_keys: z.array(zKey).max(50).optional(),
    dry_run: zDryRun,
    library_id: zLibraryID,
  }),
  annotations: WRITE,
  async run(args) {
    const libraryID = libraryOf(args.library_id, { write: true });
    if (args.parent_item_key && args.collection_keys?.length) {
      throw new ToolError("A child note can't be in collections; give parent_item_key or collection_keys, not both");
    }
    const parent = args.parent_item_key ? getItem(libraryID, args.parent_item_key) : undefined;
    if (parent && !parent.isRegularItem()) throw new ToolError(`${parent.key} is a ${parent.itemType}; notes go under regular items`);
    const collections = (args.collection_keys ?? []).map((k) => getCollection(libraryID, k));
    const html = args.format === "html" ? args.text : textToNoteHtml(args.text);
    const plan = { parentKey: parent?.key ?? null, collectionKeys: collections.map((c) => c.key), chars: args.text.length };
    if (args.dry_run) return dryRunResult("Would add a note", plan);
    const note = new Zotero.Item("note");
    note.libraryID = libraryID;
    if (parent) note.parentKey = parent.key;
    note.setNote(html);
    for (const c of collections) note.addToCollection(c.id);
    await note.saveTx();
    return { summary: `Added note ${note.key}`, data: plan };
  },
});

// ---------------------------------------------------------------------- trash

export const trashItems = defineTool({
  name: "zotero_trash_items",
  title: "Move to trash",
  description:
    "Move items to Zotero's trash (with their child attachments and notes). Reversible with zotero_restore_items until the trash is emptied. Nothing is deleted permanently.",
  input: z.object({ item_keys: zKeys, dry_run: zDryRun, library_id: zLibraryID }),
  annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
  async run(args) {
    const libraryID = libraryOf(args.library_id, { write: true });
    requireTrash(libraryID);
    const items = args.item_keys.map((k) => getItem(libraryID, k));
    const alreadyTrashed = items.filter((i) => i.deleted).map((i) => i.key);
    if (alreadyTrashed.length) throw new ToolError(`Already in the trash: ${alreadyTrashed.join(", ")}`);
    const plan = items.map(itemSummary);
    if (args.dry_run) return dryRunResult(`Would move ${count(items.length, "item")} to the trash`, plan);
    // Zotero.Items.trash labels its own undo step ("Trash N Items"), so no undoable() wrapper here.
    await Zotero.Items.trashTx(items.map((i) => i.id));
    return { summary: `Moved ${count(items.length, "item")} to the trash (restore with zotero_restore_items)`, data: plan };
  },
});

export const restoreItems = defineTool({
  name: "zotero_restore_items",
  title: "Restore from trash",
  description: "Take items back out of Zotero's trash.",
  input: z.object({ item_keys: zKeys, dry_run: zDryRun, library_id: zLibraryID }),
  annotations: WRITE_IDEMPOTENT,
  async run(args) {
    const libraryID = libraryOf(args.library_id, { write: true });
    const items = args.item_keys.map((k) => getItem(libraryID, k));
    const notTrashed = items.filter((i) => !i.deleted).map((i) => i.key);
    if (notTrashed.length) throw new ToolError(`Not in the trash: ${notTrashed.join(", ")}`);
    const plan = items.map(itemSummary);
    if (args.dry_run) return dryRunResult(`Would restore ${count(items.length, "item")}`, plan);
    await saveAllOrNone(items, { action: "undo-action-restore-items", args: { count: items.length } }, (item) => {
      item.deleted = false;
    });
    return { summary: `Restored ${count(items.length, "item")}`, data: items.map(itemSummary) };
  },
});

export const trashCollection = defineTool({
  name: "zotero_trash_collection",
  title: "Move collection to trash",
  description:
    "Move a collection and its subcollections to Zotero's trash. The items in them stay in the library. Reversible with zotero_restore_collection.",
  input: z.object({ collection_key: zKey, dry_run: zDryRun, library_id: zLibraryID }),
  annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
  async run(args) {
    const libraryID = libraryOf(args.library_id, { write: true });
    requireTrash(libraryID);
    const collection = getCollection(libraryID, args.collection_key);
    if (collection.deleted) throw new ToolError(`${collection.key} is already in the trash`);
    const sub = Zotero.Collections.getByParent(collection.id, true).filter((c) => !c.deleted);
    const plan = { collection: collectionView(collection), subcollections: sub.map((c) => `${c.key} ${c.name}`) };
    if (args.dry_run) return dryRunResult(`Would move collection ${collection.key} and ${count(sub.length, "subcollection")} to the trash`, plan);
    collection.deleted = true;
    await undoable({ action: "undo-action-trash-collection", args: { count: 1 } }, async () => {
      await collection.save();
    });
    return { summary: `Moved collection ${collection.key} "${collection.name}" to the trash (restore with zotero_restore_collection)`, data: plan };
  },
});

export const restoreCollection = defineTool({
  name: "zotero_restore_collection",
  title: "Restore collection from trash",
  description: "Take a collection back out of Zotero's trash.",
  input: z.object({ collection_key: zKey, dry_run: zDryRun, library_id: zLibraryID }),
  annotations: WRITE_IDEMPOTENT,
  async run(args) {
    const libraryID = libraryOf(args.library_id, { write: true });
    const collection = getCollection(libraryID, args.collection_key);
    if (!collection.deleted) throw new ToolError(`${collection.key} is not in the trash`);
    if (args.dry_run) return dryRunResult(`Would restore collection ${collection.key}`, { key: collection.key, name: collection.name });
    collection.deleted = false;
    await undoable({ action: "undo-action-restore-collection", args: { count: 1 } }, async () => {
      await collection.save();
    });
    return { summary: `Restored collection ${collection.key} "${collection.name}"`, data: collectionView(collection) };
  },
});

export const writeTools = [
  createCollection,
  updateCollection,
  createItem,
  updateItem,
  addFile,
  retrieveMetadata,
  renameAttachment,
  setCollections,
  setTags,
  addNote,
  trashItems,
  restoreItems,
  trashCollection,
  restoreCollection,
];
