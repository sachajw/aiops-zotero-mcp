import { z } from "zod";
import { ToolError, defineTool } from "../mcp/tool.js";
import {
  attachmentView,
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
    await collection.saveTx();
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
    await item.saveTx();
    return { summary: `Updated ${item.key} (${changes.length} field changes${args.creators ? ", creators replaced" : ""})`, data: plan };
  },
});

// ---------------------------------------------------------------- attachments

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
    // Turn off auto-recognition while adding, so Zotero doesn't wrap the PDF in a guessed parent item.
    const prefName = "extensions.zotero.autoRecognizeFiles";
    const autoRecognize = Zotero.Prefs.get(prefName, true);
    Zotero.Prefs.set(prefName, false, true);
    let attachment: ZoteroAPI.Item;
    try {
      attachment = args.mode === "import"
        ? await Zotero.Attachments.importFromFile({ ...common, libraryID })
        : await Zotero.Attachments.linkFromFile(common);
    } finally {
      Zotero.Prefs.set(prefName, autoRecognize, true);
    }
    return { summary: `Added ${attachment.key}`, data: await attachmentView(attachment) };
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
      await att.saveTx();
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
    if (args.dry_run) return dryRunResult(`Would change collections of ${items.length} items`, plan);
    for (const item of items) {
      add.forEach((c) => item.addToCollection(c.id));
      remove.forEach((c) => item.removeFromCollection(c.id));
      await item.saveTx();
    }
    return { summary: `Updated collections of ${items.length} items`, data: plan };
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
    if (args.dry_run) return dryRunResult(`Would change tags on ${items.length} items`, plan);
    for (const item of items) {
      args.add.forEach((t) => item.addTag(t));
      args.remove.forEach((t) => item.removeTag(t));
      await item.saveTx();
    }
    return { summary: `Updated tags on ${items.length} items`, data: plan };
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
    if (args.dry_run) return dryRunResult(`Would move ${items.length} items to the trash`, plan);
    await Zotero.Items.trashTx(items.map((i) => i.id));
    return { summary: `Moved ${items.length} items to the trash (restore with zotero_restore_items)`, data: plan };
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
    if (args.dry_run) return dryRunResult(`Would restore ${items.length} items`, plan);
    for (const item of items) {
      item.deleted = false;
      await item.saveTx();
    }
    return { summary: `Restored ${items.length} items`, data: items.map(itemSummary) };
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
    if (args.dry_run) return dryRunResult(`Would move collection ${collection.key} and ${sub.length} subcollections to the trash`, plan);
    collection.deleted = true;
    await collection.saveTx();
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
    await collection.saveTx();
    return { summary: `Restored collection ${collection.key} "${collection.name}"`, data: collectionView(collection) };
  },
});

export const writeTools = [
  createCollection,
  updateCollection,
  createItem,
  updateItem,
  addFile,
  renameAttachment,
  setCollections,
  setTags,
  addNote,
  trashItems,
  restoreItems,
  trashCollection,
  restoreCollection,
];
