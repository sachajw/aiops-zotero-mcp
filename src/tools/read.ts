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
  nextPage,
  noteText,
  zKey,
  zLibraryID,
} from "../zotero/library.js";
import { type RankFields, rankByScore, relevanceScore } from "../zotero/rank.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Search condition per mode (zotero searchConditions.js "quicksearch-*"). */
const SEARCH_MODES = {
  title_creator_year: "quicksearch-titleCreatorYear",
  all_fields: "quicksearch-fields",
  everything: "quicksearch-everything",
} as const;

/** Fields scored by rank.ts that aren't in RankFields.other (left out of it so they don't count twice). */
const RANKED_KEYS = new Set(["title", "creators", "date", "publicationTitle", "shortTitle", "court", "tags"]);
/** JSON keys that are bookkeeping, not text a user searches for. */
const UNRANKED_KEYS = new Set(["key", "version", "itemType", "dateAdded", "dateModified", "collections", "relations", "parentItem", "deleted", "linkMode", "contentType", "charset"]);

/** What relevance ranking reads from one item; `other` only for the modes that search all fields. */
function rankFields(item: ZoteroAPI.Item, allFields: boolean): RankFields {
  const field = (name: string) => {
    try {
      return item.getField(name) || "";
    } catch {
      return "";
    }
  };
  const other: string[] = [];
  if (allFields) {
    for (const [k, v] of Object.entries(item.toJSON())) {
      if (typeof v === "string" && v && !RANKED_KEYS.has(k) && !UNRANKED_KEYS.has(k)) other.push(v);
    }
  }
  return {
    title: field("title") || item.getDisplayTitle(),
    creators: item.isRegularItem()
      ? item.getCreators().map((c) => ({ lastName: c.lastName ?? c.name ?? "", firstName: c.firstName }))
      : [],
    year: /\d{4}/.exec(field("date"))?.[0] ?? "",
    publication: [field("publicationTitle"), field("shortTitle"), field("court")].filter(Boolean),
    tags: item.getTags().map((t) => t.tag),
    other,
  };
}

const titleOrder = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * The order to page through. Zotero.Search has no ORDER BY, so every order is computed here from
 * the full set of matches, with item ID as the tie-breaker: offset/limit pages must not repeat or
 * skip items.
 */
async function orderMatches(ids: number[], sort: SortOrder, query: string | undefined, mode: keyof typeof SEARCH_MODES): Promise<number[]> {
  const byID = [...ids].sort((a, b) => a - b);
  if (sort === "relevance" && !query) return byID;
  const items = await Zotero.Items.getAsync(byID);
  if (sort === "relevance" && query) {
    const terms = Zotero.SearchConditions.parseSearchString(query).map((p) => p.text);
    return rankByScore(items.map((item) => ({ id: item.id, score: relevanceScore(terms, rankFields(item, mode !== "title_creator_year")) })));
  }
  if (sort === "title") {
    return items.sort((a, b) => titleOrder.compare(a.getDisplayTitle(), b.getDisplayTitle()) || a.id - b.id).map((i) => i.id);
  }
  // Newest first. Zotero stores both dates as "YYYY-MM-DD hh:mm:ss" UTC, so they compare as strings; items
  // saved in the same second fall back to the higher (later) item ID first.
  const date = sort === "date_added" ? (i: ZoteroAPI.Item) => i.dateAdded : (i: ZoteroAPI.Item) => i.dateModified;
  return items.sort((a, b) => (date(a) < date(b) ? 1 : date(a) > date(b) ? -1 : b.id - a.id)).map((i) => i.id);
}

const SORT_ORDERS = ["relevance", "date_added", "date_modified", "title"] as const;
type SortOrder = (typeof SORT_ORDERS)[number];

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
    "Find items by text, collection, tag or type, or the ones in no collection (unfiled). Returns one summary per item (key, type, title, creators, date). " +
    "Use zotero_get_item for full details. Trashed items are excluded unless include_trashed is true.",
  input: z.object({
    query: z.string().min(1).optional().describe("Text to look for."),
    mode: z
      .enum(["title_creator_year", "all_fields", "everything"])
      .default("title_creator_year")
      .describe("Where to look: title/creator/year, all fields, or everything including full text and notes."),
    collection_key: zKey.optional().describe("Only items in this collection."),
    include_subcollections: z.boolean().default(false),
    unfiled: z.boolean().default(false).describe("Only items that are in no collection (Zotero's Unfiled Items)."),
    tags: z.array(z.string().min(1)).max(20).optional().describe("Only items with all of these tags."),
    item_type: z.string().min(1).optional().describe('Zotero item type, e.g. "book", "journalArticle", "attachment".'),
    top_level_only: z.boolean().default(true).describe("Leave out child attachments and notes."),
    include_trashed: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(25),
    offset: z.number().int().min(0).default(0),
    sort: z
      .enum(SORT_ORDERS)
      .default("relevance")
      .describe(
        "Order of the results: relevance to query (title matches first; without a query, item-ID order, roughly the order added), " +
        "date_added or date_modified (newest first), or title (A to Z).",
      ),
    library_id: zLibraryID,
  }),
  annotations: READ_ONLY,
  async run(args) {
    const libraryID = libraryOf(args.library_id);
    if (args.unfiled && args.collection_key) throw new ToolError("unfiled and collection_key exclude each other; give one");
    const search = new Zotero.Search();
    search.libraryID = libraryID;
    if (args.query) search.addCondition(SEARCH_MODES[args.mode], "contains", args.query);
    if (args.collection_key) {
      getCollection(libraryID, args.collection_key);
      search.addCondition("collection", "is", args.collection_key);
      if (args.include_subcollections) search.addCondition("recursive", "true");
    }
    if (args.unfiled) search.addCondition("unfiled", "true");
    for (const tag of args.tags ?? []) search.addCondition("tag", "is", tag);
    if (args.item_type) {
      if (!Zotero.ItemTypes.getID(args.item_type)) throw new ToolError(`Unknown item type: ${args.item_type}`);
      search.addCondition("itemType", "is", args.item_type);
    }
    if (args.top_level_only) search.addCondition("noChildren", "true");
    if (args.include_trashed) search.addCondition("includeDeleted", "true");

    const ids = await orderMatches(await search.search(), args.sort, args.query, args.mode);
    const page = ids.slice(args.offset, args.offset + args.limit);
    // getAsync doesn't promise to keep the order it was given, so put the page back in order.
    const byID = new Map((await Zotero.Items.getAsync(page)).map((i) => [i.id, i]));
    const items = page.map((id) => byID.get(id)).filter((i): i is ZoteroAPI.Item => i !== undefined);
    const shown = items.length;
    const more = nextPage(args.offset, shown, ids.length);
    const order = args.sort === "relevance" && !args.query ? "item ID" : args.sort.replace("_", " ");
    return {
      summary: `${count(ids.length, "matching item")}, by ${order}; showing ${shown} from offset ${args.offset}` +
        (more.hasMore ? `. More: offset ${more.nextOffset}.` : ""),
      data: { total: ids.length, offset: args.offset, ...more, items: items.map(itemSummary) },
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
  description:
    "List collections with their keys, full paths and item counts. Top level by default, or the children of parent_key. " +
    "Give name to find collections by name at any depth (e.g. name: \"Docker\" finds Platform Engineering / Cloud Native / Containers / Docker).",
  input: z.object({
    parent_key: zKey.optional().describe("List the subcollections of this collection."),
    recursive: z.boolean().default(false).describe("Include all descendants, not just one level."),
    name: z.string().trim().min(1).optional().describe("Only collections whose name contains this text (case-insensitive), at any depth below parent_key or the library."),
    library_id: zLibraryID,
  }),
  annotations: READ_ONLY,
  async run(args) {
    const libraryID = libraryOf(args.library_id);
    let collections: ZoteroAPI.Collection[];
    if (args.parent_key) {
      const parent = getCollection(libraryID, args.parent_key);
      collections = Zotero.Collections.getByParent(parent.id, args.recursive || Boolean(args.name));
    } else {
      collections = Zotero.Collections.getByLibrary(libraryID, args.recursive || Boolean(args.name));
    }
    const needle = args.name?.toLowerCase();
    const live = collections.filter((c) => !c.deleted && (!needle || c.name.toLowerCase().includes(needle)));
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
      // attachmentText throws (rather than returning nothing) for a PDF whose file is missing,
      // so check the file first and move on to the next attachment.
      const path = await att.getFilePathAsync();
      if (!path || !(await IOUtils.exists(path))) continue;
      const text = await att.attachmentText;
      if (!text) continue;
      const slice = text.slice(args.offset, args.offset + args.max_chars);
      const next = args.offset + slice.length;
      const more = nextPage(args.offset, slice.length, text.length);
      return {
        summary:
          `Text of ${att.key} (${att.attachmentFilename || att.getField("title")}): characters ${args.offset}–${next} of ${text.length}` +
          (more.hasMore ? `. More: offset ${more.nextOffset}.` : "."),
        data: { attachmentKey: att.key, totalChars: text.length, offset: args.offset, ...more, text: slice },
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
