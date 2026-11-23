/**
 * Live tests: every tool against a running Zotero with this plugin installed.
 *
 * Needs ZOTERO_MCP_TOKEN (run: fnox exec -P shell -- mise run test:live). Skips, does not fail,
 * when the endpoint is unreachable or has no token. Works in a throwaway collection named
 * "aiops-mcp-test <timestamp>" and moves everything it made to Zotero's trash at the end
 * (the plugin can't empty the trash, by design).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL_ = process.env.ZOTERO_MCP_URL ?? "http://127.0.0.1:23119/aiops-mcp";
const TOKEN = process.env.ZOTERO_MCP_TOKEN ?? "";
let nextId = 1;

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(URL_, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      Authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

interface ToolResult {
  isError: boolean;
  text: string;
  data: unknown;
}

async function tool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const res = await post({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: { isError: boolean; content: Array<{ text: string }> }; error?: unknown };
  if (!body.result) throw new Error(`JSON-RPC error from ${name}: ${JSON.stringify(body.error)}`);
  const text = body.result.content[0].text;
  const split = text.indexOf("\n\n");
  let data: unknown;
  if (split >= 0) {
    try {
      data = JSON.parse(text.slice(split + 2));
    } catch {
      data = undefined;
    }
  }
  return { isError: body.result.isError, text, data };
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const r = await tool(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.text}`);
  return r;
}

async function endpointReady(): Promise<string> {
  if (!TOKEN) return "ZOTERO_MCP_TOKEN is not set";
  try {
    const res = await post({ jsonrpc: "2.0", id: 0, method: "ping" });
    return res.status === 200 ? "" : `endpoint answered HTTP ${res.status}`;
  } catch (e) {
    return `no endpoint at ${URL_}: ${(e as Error).message}`;
  }
}

const notReady = await endpointReady();
if (notReady) console.warn(`[live] skipping - ${notReady}`);

describe.skipIf(Boolean(notReady))("aiops-zotero-mcp against a live Zotero", () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const TAG = `aiops-mcp-test-${stamp}`;
  const created: string[] = [];
  let collectionKey = "";
  let subKey = "";
  let bookKey = "";
  let fileDir = "";

  beforeAll(async () => {
    fileDir = mkdtempSync(join(tmpdir(), "aiops-zotero-mcp-"));
    const r = await ok("zotero_create_collection", { name: `aiops-mcp-test ${stamp}` });
    collectionKey = (r.data as { key: string }).key;
  });

  afterAll(async () => {
    if (created.length) await tool("zotero_trash_items", { item_keys: created.filter((k, i, a) => a.indexOf(k) === i) });
    if (collectionKey) await tool("zotero_trash_collection", { collection_key: collectionKey });
    if (fileDir) rmSync(fileDir, { recursive: true, force: true });
  });

  describe("transport and security", () => {
    it("refuses a wrong token with 401", async () => {
      const res = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: "Bearer wrong" });
      expect(res.status).toBe(401);
    });

    it("refuses a request with a browser Origin", async () => {
      // Zotero 10 drops browser requests itself before the endpoint runs (connection closed);
      // older Zotero reaches our handler, which answers 403. Either way: never served.
      const outcome = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "http://evil.example" })
        .then((res) => res.status)
        .catch(() => "connection closed");
      expect([403, "connection closed"]).toContain(outcome);
    });

    it("sends proper reason phrases for 401 (not 'undefined')", async () => {
      const res = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: "Bearer wrong" });
      expect(res.statusText).toBe("Unauthorized");
    });

    it("returns 405 for GET", async () => {
      const res = await fetch(URL_, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" } });
      expect(res.status).toBe(405);
    });

    it("lists all tools", async () => {
      const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
      expect(body.result.tools.length).toBe(24);
    });

    it("answers 12 parallel calls, each with its own result", async () => {
      const keys = await Promise.all(
        Array.from({ length: 12 }, async (_, i) => {
          const res = await post({ jsonrpc: "2.0", id: 1000 + i, method: "tools/call", params: { name: "zotero_list_libraries", arguments: {} } });
          const body = (await res.json()) as { id: number; result: { isError: boolean } };
          expect(body.result.isError).toBe(false);
          return body.id;
        }),
      );
      expect(keys).toEqual(Array.from({ length: 12 }, (_, i) => 1000 + i));
    });
  });

  describe("errors the model can correct", () => {
    it("rejects a malformed key before touching Zotero", async () => {
      const r = await tool("zotero_get_item", { item_key: "nope" });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Invalid arguments/);
    });

    it("reports an unknown key", async () => {
      const r = await tool("zotero_get_item", { item_key: "ZZZZZZZZ" });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/No item with key ZZZZZZZZ/);
    });

    it("lists valid fields when a field name is wrong", async () => {
      const r = await tool("zotero_create_item", { item_type: "book", fields: { journal: "x" }, dry_run: true });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Not fields of book: journal\. Valid: .*title/);
    });
  });

  describe("library management", () => {
    it("dry run changes nothing", async () => {
      const before = await ok("zotero_list_collections", { parent_key: collectionKey });
      const r = await ok("zotero_create_collection", { name: "should not exist", parent_key: collectionKey, dry_run: true });
      expect(r.text).toMatch(/^Dry run, nothing changed/);
      const after = await ok("zotero_list_collections", { parent_key: collectionKey });
      expect(after.data).toEqual(before.data);
    });

    it("creates and renames a subcollection", async () => {
      const r = await ok("zotero_create_collection", { name: "sub", parent_key: collectionKey });
      subKey = (r.data as { key: string }).key;
      await ok("zotero_update_collection", { collection_key: subKey, name: "sub renamed" });
      const list = await ok("zotero_list_collections", { parent_key: collectionKey });
      expect(list.data).toEqual([expect.objectContaining({ key: subKey, name: "sub renamed", parentKey: collectionKey })]);
    });

    it("finds a collection by name at any depth, with its full path", async () => {
      const r = await ok("zotero_list_collections", { name: `test ${stamp}` });
      expect(r.data).toEqual([expect.objectContaining({ key: collectionKey, path: `aiops-mcp-test ${stamp}` })]);
      const nested = await ok("zotero_list_collections", { name: "SUB RENAMED", parent_key: collectionKey });
      expect(nested.data).toEqual([expect.objectContaining({ key: subKey, path: `aiops-mcp-test ${stamp} / sub renamed` })]);
    });

    it("refuses to move a collection inside itself", async () => {
      const r = await tool("zotero_update_collection", { collection_key: collectionKey, parent_key: subKey });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/loop/);
    });

    it("creates an item in the collection", async () => {
      const r = await ok("zotero_create_item", {
        item_type: "book",
        fields: { title: `Test Book ${stamp}`, date: "2024", publisher: "Example Press" },
        creators: [{ creator_type: "author", first_name: "Ada", last_name: "Lovelace" }],
        tags: [TAG],
        collection_keys: [collectionKey],
      });
      bookKey = (r.data as { key: string }).key;
      created.push(bookKey);
      const item = await ok("zotero_get_item", { item_key: bookKey });
      expect(item.data).toMatchObject({ itemType: "book", title: `Test Book ${stamp}`, collectionKeys: [collectionKey] });
    });

    it("links and unlinks related items both ways, with a dry run first", async () => {
      // Not in the test collection: later tests expect it to hold only the book. Trashed at the end with the rest.
      const r = await ok("zotero_create_item", { item_type: "book", fields: { title: `Companion ${stamp}` } });
      const otherKey = (r.data as { key: string }).key;
      created.push(otherKey);
      const related = async (key: string) => ((await ok("zotero_get_item", { item_key: key })).data as { related: Array<{ key: string }> }).related.map((x) => x.key);

      const dry = await ok("zotero_set_related", { item_key: bookKey, add: [otherKey], dry_run: true });
      expect(dry.text).toMatch(/^Dry run, nothing changed/);
      expect(await related(bookKey)).toEqual([]);

      await ok("zotero_set_related", { item_key: bookKey, add: [otherKey] });
      expect(await related(bookKey)).toEqual([otherKey]);
      expect(await related(otherKey)).toEqual([bookKey]);
      const again = await ok("zotero_set_related", { item_key: bookKey, add: [otherKey] });
      expect(again.text).toMatch(/Nothing to change/);

      const self = await tool("zotero_set_related", { item_key: bookKey, add: [bookKey] });
      expect(self.isError).toBe(true);

      await ok("zotero_set_related", { item_key: otherKey, remove: [bookKey] });
      expect(await related(bookKey)).toEqual([]);
      expect(await related(otherKey)).toEqual([]);
    });

    it("updates fields and finds the item by search, tag and collection", async () => {
      await ok("zotero_update_item", { item_key: bookKey, fields: { publisher: "Other Press" } });
      const byText = await ok("zotero_search_items", { query: `Test Book ${stamp}` });
      expect((byText.data as { items: Array<{ key: string }> }).items.map((i) => i.key)).toContain(bookKey);
      const byTag = await ok("zotero_search_items", { tags: [TAG] });
      expect((byTag.data as { total: number }).total).toBe(1);
      const inColl = await ok("zotero_search_items", { collection_key: collectionKey });
      expect((inColl.data as { items: Array<{ key: string }> }).items.map((i) => i.key)).toEqual([bookKey]);
      const item = await ok("zotero_get_item", { item_key: bookKey });
      expect(item.data).toMatchObject({ publisher: "Other Press" });
      // The book is in the test collection, so the unfiled filter leaves it out.
      const unfiled = await ok("zotero_search_items", { query: `Test Book ${stamp}`, unfiled: true });
      expect((unfiled.data as { total: number }).total).toBe(0);
      const both = await tool("zotero_search_items", { unfiled: true, collection_key: collectionKey });
      expect(both.isError).toBe(true);
    });

    it("ranks search results by relevance, and sorts by title or date added", async () => {
      // Mentions the book's title only in Extra, so it matches in all_fields mode but ranks below the book.
      const r = await ok("zotero_create_item", { item_type: "book", fields: { title: `Appendix ${stamp}`, extra: `See Test Book ${stamp}` } });
      const appendixKey = (r.data as { key: string }).key;
      created.push(appendixKey);
      const keys = async (args: Record<string, unknown>) =>
        ((await ok("zotero_search_items", { query: `Test Book ${stamp}`, mode: "all_fields", ...args })).data as { items: Array<{ key: string }> })
          .items.map((i) => i.key);
      expect(await keys({})).toEqual([bookKey, appendixKey]);
      expect(await keys({ sort: "title" })).toEqual([appendixKey, bookKey]);
      expect(await keys({ sort: "date_added" })).toEqual([appendixKey, bookKey]);
      const paged = await ok("zotero_search_items", { query: `Test Book ${stamp}`, mode: "all_fields", limit: 1, offset: 1 });
      expect((paged.data as { items: Array<{ key: string }> }).items.map((i) => i.key)).toEqual([appendixKey]);
      expect(paged.text).toMatch(/by relevance/);
    });

    it("adds a file under the item, reads its text, and renames it", async () => {
      const path = join(fileDir, "notes source.txt");
      writeFileSync(path, `Marker ${stamp}: the quick brown fox.`);
      const add = await ok("zotero_add_file", { path, parent_item_key: bookKey, title: "Source text" });
      const attKey = (add.data as { key: string }).key;
      expect(add.data).toMatchObject({ fileExists: true, linkMode: "imported_file" });

      const text = await ok("zotero_get_fulltext", { item_key: attKey });
      expect((text.data as { text: string }).text).toContain(`Marker ${stamp}`);

      await ok("zotero_rename_attachment", { item_key: attKey, title: "Renamed source", filename: "renamed-source" });
      const att = await ok("zotero_get_attachment", { item_key: attKey });
      expect(att.data).toMatchObject({ title: "Renamed source", filename: "renamed-source.txt", fileExists: true });
    });

    it("retrieves metadata only for standalone PDFs, and reports a miss", async () => {
      const notAttachment = await tool("zotero_retrieve_metadata", { item_keys: [bookKey] });
      expect(notAttachment.isError).toBe(true);
      expect(notAttachment.text).toMatch(/not an attachment/);

      // A PDF with no text: Zotero gives up before contacting its metadata service.
      const path = join(fileDir, "blank.pdf");
      writeFileSync(path, "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
        "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
      const add = await ok("zotero_add_file", { path, collection_keys: [collectionKey] });
      const pdfKey = (add.data as { key: string }).key;
      created.push(pdfKey);
      expect(add.data).toMatchObject({ contentType: "application/pdf" });

      const dry = await ok("zotero_retrieve_metadata", { item_keys: [pdfKey], dry_run: true });
      expect(dry.text).toMatch(/^Dry run/);

      const run = await ok("zotero_retrieve_metadata", { item_keys: [pdfKey] });
      expect(run.data).toEqual([expect.objectContaining({ key: pdfKey, status: "not_recognized" })]);
      const att = await ok("zotero_get_item", { item_key: pdfKey });
      expect((att.data as Record<string, unknown>).parentItem).toBeUndefined();
    });

    it("refuses a relative path", async () => {
      const r = await tool("zotero_add_file", { path: "relative.txt", collection_keys: [collectionKey] });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/absolute/);
    });

    it("adds a note and reads it back as text", async () => {
      await ok("zotero_add_note", { parent_item_key: bookKey, text: "First line\nsecond line\n\nNew para <b>not bold</b>" });
      const notes = await ok("zotero_list_notes", { item_key: bookKey });
      expect(notes.data).toEqual([expect.objectContaining({ text: "First line\nsecond line\n\nNew para <b>not bold</b>" })]);
    });

    it("moves the item between collections and changes tags", async () => {
      await ok("zotero_set_collections", { item_keys: [bookKey], add: [subKey], remove: [collectionKey] });
      await ok("zotero_set_tags", { item_keys: [bookKey], add: ["second-tag"], remove: [TAG] });
      const item = await ok("zotero_get_item", { item_key: bookKey });
      expect(item.data).toMatchObject({ collectionKeys: [subKey] });
      const tags = (item.data as { tags: Array<{ tag: string }> }).tags.map((t) => t.tag);
      expect(tags).toEqual(["second-tag"]);
    });

    it("formats a bibliography and a citation", async () => {
      const bib = await ok("zotero_cite", { item_keys: [bookKey], style: "apa" });
      expect(bib.text).toMatch(/Lovelace/);
      expect(bib.text).toMatch(new RegExp(`Test Book ${stamp}`));
      const cite = await ok("zotero_cite", { item_keys: [bookKey], kind: "citation" });
      expect(cite.text).toMatch(/Lovelace, 2024/);
    });

    it("trashes and restores the item, and refuses double trashing", async () => {
      await ok("zotero_trash_items", { item_keys: [bookKey] });
      const again = await tool("zotero_trash_items", { item_keys: [bookKey] });
      expect(again.isError).toBe(true);
      const hidden = await ok("zotero_search_items", { query: `Test Book ${stamp}` });
      expect((hidden.data as { total: number }).total).toBe(0);
      const shown = await ok("zotero_search_items", { query: `Test Book ${stamp}`, include_trashed: true });
      expect((shown.data as { total: number }).total).toBe(1);
      await ok("zotero_restore_items", { item_keys: [bookKey] });
      const back = await ok("zotero_get_item", { item_key: bookKey });
      expect(back.data).toMatchObject({ inTrash: false });
    });

    it("trashes and restores a collection, leaving its items in the library", async () => {
      await ok("zotero_trash_collection", { collection_key: subKey });
      const list = await ok("zotero_list_collections", { parent_key: collectionKey });
      expect(list.data).toEqual([]);
      const item = await ok("zotero_get_item", { item_key: bookKey });
      expect(item.data).toMatchObject({ inTrash: false });
      await ok("zotero_restore_collection", { collection_key: subKey });
      const restored = await ok("zotero_list_collections", { parent_key: collectionKey });
      expect(restored.data).toEqual([expect.objectContaining({ key: subKey })]);
    });
  });
});
