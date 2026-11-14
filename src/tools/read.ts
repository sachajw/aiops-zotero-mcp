import { z } from "zod";
import { ToolError, defineTool } from "../mcp/tool.js";
import {
  attachmentView,
  count,
  collectionView,
  getCollection,
  getItem,
  itemDetail,
  itemSummary,
  libraryOf,
  noteText,
  zKey,
  zLibraryID,
} from "../zotero/library.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Search condition per mode (zotero searchConditions.js "quicksearch-*"). */
const SEARCH_MODES = {
  title_creator_year: "quicksearch-titleCreatorYear",
  all_fields: "quicksearch-fields",
  everything: "quicksearch-everything",
} as const;

export const listLibraries = defineTool({
  name: "zotero_list_libraries",
  title: "List libraries",
  description: "List the Zotero libraries (My Library and groups) with their IDs and whether they can be edited.",
  input: z.object({}),
  annotations: READ_ONLY,
  async run() {
    const libraries = Zotero.Libraries.getAll().map((l) => ({
      libraryID: l.libraryID,
      name: l.name,
      type: l.libraryType,
      editable: l.editable,
      isMyLibrary: l.libraryID === Zotero.Libraries.userLibraryID,
    }));
    return { summary: count(libraries.length, "library", "libraries"), data: libraries };
  },
});

export const searchItems = defineTool({
  name: "zotero_search_items",
  title: "Search items",
  description:
    "Find items by text, collection, tag or type. Returns one summary per item (key, type, title, creators, date). " +
    "Use zotero_get_item for full details. Trashed items are excluded unless include_trashed is true.",
  input: z.object({
    query: z.string().min(1).optional().describe("Text to look for."),
    mode: z
      .enum(["title_creator_year", "all_fields", "everything"])
      .default("title_creator_year")
      .describe("Where to look: title/creator/year, all fields, or everything including full text and notes."),
    collection_key: zKey.optional().describe("Only items in this collection."),
    include_subcollections: z.boolean().default(false),
    tags: z.array(z.string().min(1)).max(20).optional().describe("Only items with all of these tags."),
    item_type: z.string().min(1).optional().describe('Zotero item type, e.g. "book", "journalArticle", "attachment".'),
    top_level_only: z.boolean().default(true).describe("Leave out child attachments and notes."),
    include_trashed: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(25),
    offset: z.number().int().min(0).default(0),
    library_id: zLibraryID,
  }),
  annotations: READ_ONLY,
  async run(args) {
    const libraryID = libraryOf(args.library_id);
    const search = new Zotero.Search();
    search.libraryID = libraryID;
    if (args.query) search.addCondition(SEARCH_MODES[args.mode], "contains", args.query);
    if (args.collection_key) {
      getCollection(libraryID, args.collection_key);
      search.addCondition("collection", "is", args.collection_key);
      if (args.include_subcollections) search.addCondition("recursive", "true");
    }
    for (const tag of args.tags ?? []) search.addCondition("tag", "is", tag);
    if (args.item_type) {
      if (!Zotero.ItemTypes.getID(args.item_type)) throw new ToolError(`Unknown item type: ${args.item_type}`);
      search.addCondition("itemType", "is", args.item_type);
    }
    if (args.top_level_only) search.addCondition("noChildren", "true");
    if (args.include_trashed) search.addCondition("includeDeleted", "true");

    const ids = await search.search();
    const page = ids.slice(args.offset, args.offset + args.limit);
    const items = await Zotero.Items.getAsync(page);
    const shown = items.length;
    return {
      summary: `${count(ids.length, "matching item")}; showing ${shown} from offset ${args.offset}`,
      data: { total: ids.length, offset: args.offset, items: items.map(itemSummary) },
    };
  },
});

export const getItemTool = defineTool({
  name: "zotero_get_item",
  title: "Get item",
  description:
    "Everything about one item: all fields, creators, tags, collections, attachments (with whether the file exists) and notes as text.",
  input: z.object({ item_key: zKey, library_id: zLibraryID }),
  annotations: READ_ONLY,
  async run(args) {
    const item = getItem(libraryOf(args.library_id), args.item_key);
    return { summary: `${item.itemType} ${item.key}: ${item.getDisplayTitle()}`, data: await itemDetail(item) };
  },
});

export const listCollections = defineTool({
  name: "zotero_list_collections",
  title: "List collections",
  description: "List collections with their keys, parent keys and item counts. Top level by default, or the children of parent_key.",
  input: z.object({
    parent_key: zKey.optional().describe("List the subcollections of this collection."),
    recursive: z.boolean().default(false).describe("Include all descendants, not just one level."),
    library_id: zLibraryID,
  }),
  annotations: READ_ONLY,
  async run(args) {
    const libraryID = libraryOf(args.library_id);
    let collections: ZoteroAPI.Collection[];
    if (args.parent_key) {
      const parent = getCollection(libraryID, args.parent_key);
      collections = Zotero.Collections.getByParent(parent.id, args.recursive);
    } else {
      collections = Zotero.Collections.getByLibrary(libraryID, args.recursive);
    }
    const live = collections.filter((c) => !c.deleted);
    return { summary: count(live.length, "collection"), data: live.map(collectionView) };
  },
});

/** An attachment key, or a regular item key resolved to its best attachments. */
async function attachmentsFor(libraryID: number, key: string): Promise<ZoteroAPI.Item[]> {
  const item = getItem(libraryID, key);
  if (item.isAttachment()) return [item];
  if (!item.isRegularItem()) throw new ToolError(`${key} is a ${item.itemType}, not an item with attachments`);
  const atts = Zotero.Items.get(item.getAttachments());
  if (!atts.length) throw new ToolError(`${key} has no attachments`);
  return atts;
}

export const getFulltext = defineTool({
  name: "zotero_get_fulltext",
  title: "Get full text",
  description:
    "Read the text of an attachment (PDF, EPUB, HTML snapshot, plain text). Pass the attachment key, or a parent item key to read its first attachment that has text. " +
    "Long texts come in pages: use offset to continue.",
  input: z.object({
    item_key: zKey,
    offset: z.number().int().min(0).default(0).describe("Character offset to start from."),
    max_chars: z.number().int().min(100).max(100_000).default(20_000),
    library_id: zLibraryID,
  }),
  annotations: READ_ONLY,
  async run(args) {
    const libraryID = libraryOf(args.library_id);
    for (const att of await attachmentsFor(libraryID, args.item_key)) {
      const text = await att.attachmentText;
      if (!text) continue;
      const slice = text.slice(args.offset, args.offset + args.max_chars);
      const next = args.offset + slice.length;
      return {
        summary:
          `Text of ${att.key} (${att.attachmentFilename || att.getField("title")}): characters ${args.offset}–${next} of ${text.length}` +
          (next < text.length ? `. More: offset ${next}.` : "."),
        data: { attachmentKey: att.key, totalChars: text.length, offset: args.offset, text: slice },
      };
    }
    throw new ToolError(`No readable text for ${args.item_key}: not indexed, or the file is missing or not a text format`);
  },
});

export const getAnnotations = defineTool({
  name: "zotero_get_annotations",
  title: "Get annotations",
  description: "Highlights, notes and other annotations made in Zotero's reader, for an attachment or for all attachments of an item.",
  input: z.object({ item_key: zKey, library_id: zLibraryID }),
  annotations: READ_ONLY,
  async run(args) {
    const libraryID = libraryOf(args.library_id);
    const out: Array<Record<string, unknown>> = [];
    for (const att of await attachmentsFor(libraryID, args.item_key)) {
      for (const a of att.getAnnotations()) {
        out.push({
          key: a.key,
          attachmentKey: att.key,
          type: a.annotationType,
          text: a.annotationText || undefined,
          comment: a.annotationComment || undefined,
          color: a.annotationColor || undefined,
          page: a.annotationPageLabel || undefined,
          tags: a.getTags().map((t) => t.tag),
        });
      }
    }
    return { summary: count(out.length, "annotation"), data: out };
  },
});

async function stylesReady(): Promise<void> {
  try {
    Zotero.Styles.getVisible();
  } catch {
    await Zotero.Styles.init();
  }
}

function resolveStyle(id: string): ZoteroAPI.Style {
  const full = id.includes("/") ? id : `http://www.zotero.org/styles/${id}`;
  const style = Zotero.Styles.get(full);
  if (style) return style;
  const installed = Zotero.Styles.getVisible().map((s) => s.styleID.replace("http://www.zotero.org/styles/", ""));
  throw new ToolError(`Style "${id}" is not installed. Installed: ${installed.join(", ")}`);
}

export const cite = defineTool({
  name: "zotero_cite",
  title: "Format citations",
  description:
    "Format items as a bibliography or as in-text citations with a citation style installed in Zotero (e.g. apa, chicago-note-bibliography, ieee, harvard-cite-them-right).",
  input: z.object({
    item_keys: z.array(zKey).min(1).max(100),
    style: z.string().min(1).default("apa").describe("Style ID or short name of an installed style."),
    kind: z.enum(["bibliography", "citation"]).default("bibliography"),
    format: z.enum(["text", "html"]).default("text"),
    locale: z.string().min(2).default("en-US"),
    library_id: zLibraryID,
  }),
  annotations: READ_ONLY,
  async run(args) {
    const libraryID = libraryOf(args.library_id);
    const items = args.item_keys.map((k) => getItem(libraryID, k));
    const notCitable = items.filter((i) => !i.isRegularItem());
    if (notCitable.length) {
      throw new ToolError(`Only regular items can be cited; not: ${notCitable.map((i) => `${i.key} (${i.itemType})`).join(", ")}`);
    }
    await stylesReady();
    const style = resolveStyle(args.style);
    const engine = style.getCiteProc(args.locale, args.format, { cache: true });
    try {
      const output = Zotero.Cite.makeFormattedBibliographyOrCitationList(
        engine,
        items,
        args.format,
        args.kind === "citation",
      );
      return { summary: `${args.kind} in ${style.title}, ${args.format}:\n\n${output.trim()}` };
    } finally {
      engine.free();
    }
  },
});

export const listNotes = defineTool({
  name: "zotero_list_notes",
  title: "List notes",
  description: "The notes attached to an item, as plain text.",
  input: z.object({ item_key: zKey, include_trashed: z.boolean().default(false), library_id: zLibraryID }),
  annotations: READ_ONLY,
  async run(args) {
    const item = getItem(libraryOf(args.library_id), args.item_key);
    if (!item.isRegularItem()) throw new ToolError(`${item.key} is a ${item.itemType}; notes belong to regular items`);
    const notes = Zotero.Items.get(item.getNotes(args.include_trashed)).map((n) => ({
      key: n.key,
      dateModified: n.dateModified,
      text: noteText(n.getNote()),
    }));
    return { summary: `${count(notes.length, "note")} on ${item.key}`, data: notes };
  },
});

export const getAttachment = defineTool({
  name: "zotero_get_attachment",
  title: "Get attachment",
  description: "File details of one attachment: title, filename, content type, link mode and whether the file exists.",
  input: z.object({ item_key: zKey, library_id: zLibraryID }),
  annotations: READ_ONLY,
  async run(args) {
    const att = getItem(libraryOf(args.library_id), args.item_key);
    if (!att.isAttachment()) throw new ToolError(`${att.key} is a ${att.itemType}, not an attachment`);
    return { summary: `Attachment ${att.key}`, data: await attachmentView(att) };
  },
});

export const readTools = [
  listLibraries,
  searchItems,
  getItemTool,
  listCollections,
  getAttachment,
  getFulltext,
  getAnnotations,
  listNotes,
  cite,
];
