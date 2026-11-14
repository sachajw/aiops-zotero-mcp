# Using the Zotero MCP server

How to use aiops-zotero-mcp day to day: connecting an agent, what to ask, how changes stay safe, and what to do when something fails. It covers your whole Zotero library: My Library, every collection and any group libraries you can access. For installing the plugin, see the [README](../README.md#install).

## 1. Before you start

- **Zotero is running** with the plugin enabled: **Tools → Plugins → "aiops Zotero MCP"**. The server lives inside Zotero, so it is only there while Zotero is open.
- **The token is set in two places with the same value**:
  - in Zotero, preference `extensions.aiops-zotero-mcp.token` (Settings → Advanced → Config Editor);
  - in the environment of whatever starts your agent, as `ZOTERO_MCP_TOKEN` (from fnox: `fnox exec -P shell -- <command>`, or a shell that already exports it).

Check from a terminal (the token goes in a header file, never on the command line):

```bash
umask 077; H=$(mktemp); printf 'Authorization: Bearer %s\n' "$ZOTERO_MCP_TOKEN" > "$H"
curl -s -X POST http://127.0.0.1:23119/aiops-mcp -H @"$H" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'; rm -f "$H"
# expected: {"jsonrpc":"2.0","id":1,"result":{}}
```

## 2. Connect an agent

### Claude Code

```bash
claude mcp add --transport http --scope user zotero http://127.0.0.1:23119/aiops-mcp \
  --header 'Authorization: Bearer ${ZOTERO_MCP_TOKEN}'
```

Keep the single quotes: `${ZOTERO_MCP_TOKEN}` is stored as a reference and filled in from the environment when Claude Code starts, so the token is never written to the config. Start Claude from a shell that has the variable, then:

- `claude mcp get zotero` should show **Status: ✔ Connected**;
- inside a session, `/mcp` shows `zotero` as connected.

If you manage MCP servers with CCS on-demand groups, the group is `zotero` (`mcp-zotero` adds it).

### Any other MCP client

| Setting | Value |
|---|---|
| Transport | Streamable HTTP |
| URL | `http://127.0.0.1:23119/aiops-mcp` |
| Header | `Authorization: Bearer <token>` |

The port is Zotero's `httpServer.port` preference (23119 unless you changed it).

## 3. What to ask

Ask in plain language; the agent picks the tools. Some examples across a library:

**Find and read**
- "What do I have in Zotero on transformer interpretability from the last five years?"
- "List my collections and how many items each has."
- "Show everything tagged `to-read` that has a PDF."
- "Read the PDF of the Vaswani paper and summarise its method section."
- "Search the full text of my library for 'contrastive loss'." (searches PDFs and notes too)
- "Show my highlights and comments in that book."

**Cite**
- "Give me an APA bibliography of everything in my Thesis collection."
- "Format these three items as Chicago in-text citations."
- "Cite it in Vancouver style." (if a style isn't installed, the reply lists the ones that are)

**Organise**
- "Create a collection 'Reading group 2026' under Projects."
- "Move every item tagged `ml` from Inbox to Machine Learning."
- "Rename the attachment of that paper to 'author-year-title.pdf'."
- "Tag the five most recent items `review`."
- "Add a note to that book: key arguments are ..."

**Add**
- "Add ~/Downloads/paper.pdf to my Inbox collection."
- "Attach ~/Documents/slides.pdf to the conference paper by Smith."
- "Create a book item: title ..., author ..., year ..., publisher ..."

**Tidy up**
- "Trash the second copy of that paper." (reversible, see below)
- "Restore the items I trashed today."

For anything that changes the library, add **"dry run first"**: the agent shows exactly what would change, and you confirm before it does it.

## 4. How it works

### Keys

Every item, attachment, note and collection has an 8-character key such as `ABCD2345`. Search and list tools return keys; other tools take them. You rarely need to type one: the agent carries them between steps.

### Libraries

Tools work on My Library unless `library_id` is given. `zotero_list_libraries` shows group libraries and whether you can edit them; changes to a read-only group are refused.

### Dry run

Every tool that changes something takes `dry_run: true` and reports what it would do without doing it, for example:

```text
Dry run, nothing changed. Would create collection "Example"

{
  "name": "Example",
  "parentKey": null,
  "libraryID": 1
}
```

### Nothing is deleted permanently

- `zotero_trash_items` and `zotero_trash_collection` move things to Zotero's trash; `zotero_restore_items` and `zotero_restore_collection` take them back.
- Trashing a collection trashes its subcollections; the items in it stay in your library.
- No tool empties the trash or erases anything. In a library that has no trash, removing is refused.

### Adding files

`zotero_add_file` takes an absolute path on this computer.

- `mode: "import"` (default) copies the file into Zotero's storage.
- `mode: "link"` links to it in place (My Library only).
- Give `parent_item_key` to attach it to an item, or `collection_keys` for a standalone attachment.
- Zotero's "Automatically retrieve metadata for PDFs" is switched off while the file is added, so the PDF is not wrapped in a guessed parent item, and switched back to your setting afterwards.

### Reading long texts

`zotero_get_fulltext` returns up to `max_chars` (default 20,000) and tells you the next `offset`. The agent can page through a whole book. Text comes from Zotero's full-text index, or is extracted from the PDF if it has not been indexed yet.

## 5. Tool reference

Required parameters are marked \*. Defaults in brackets. Every tool also takes `library_id` (default My Library).

**Read (never change anything)**

| Tool | Parameters |
|---|---|
| `zotero_list_libraries` | none |
| `zotero_search_items` | `query`, `mode` [`title_creator_year`] \| `all_fields` \| `everything`, `collection_key`, `include_subcollections` [false], `tags`, `item_type`, `top_level_only` [true], `include_trashed` [false], `limit` [25, max 200], `offset` [0] |
| `zotero_get_item` | `item_key`\* |
| `zotero_list_collections` | `parent_key`, `recursive` [false] |
| `zotero_get_attachment` | `item_key`\* |
| `zotero_get_fulltext` | `item_key`\* (attachment, or parent item), `offset` [0], `max_chars` [20000] |
| `zotero_get_annotations` | `item_key`\* (attachment, or parent item) |
| `zotero_list_notes` | `item_key`\*, `include_trashed` [false] |
| `zotero_cite` | `item_keys`\*, `style` [`apa`], `kind` [`bibliography`] \| `citation`, `format` [`text`] \| `html`, `locale` [`en-US`] |

**Change (all take `dry_run` [false])**

| Tool | Parameters |
|---|---|
| `zotero_create_collection` | `name`\*, `parent_key` |
| `zotero_update_collection` | `collection_key`\*, `name`, `parent_key` (null = top level) |
| `zotero_create_item` | `item_type`\*, `fields` [{}], `creators`, `tags`, `collection_keys` |
| `zotero_update_item` | `item_key`\*, `fields` (empty string clears), `creators` (replaces all) |
| `zotero_add_file` | `path`\* (absolute), `mode` [`import`] \| `link`, `title`, `parent_item_key`, `collection_keys` |
| `zotero_rename_attachment` | `item_key`\*, `title`, `filename` (extension kept if omitted; never overwrites) |
| `zotero_set_collections` | `item_keys`\*, `add` [], `remove` [] |
| `zotero_set_tags` | `item_keys`\*, `add` [], `remove` [] |
| `zotero_add_note` | `text`\*, `format` [`text`] \| `html`, `parent_item_key`, `collection_keys` |
| `zotero_trash_items` | `item_keys`\* |
| `zotero_restore_items` | `item_keys`\* |
| `zotero_trash_collection` | `collection_key`\* |
| `zotero_restore_collection` | `collection_key`\* |

Creators are `{"creator_type": "author", "first_name": "Ada", "last_name": "Lovelace"}` or `{"creator_type": "author", "name": "Example Org"}`. Field names and creator types are checked against Zotero's schema for the item type; a wrong one comes back with the list of valid ones.

## 6. When something fails

| You see | Meaning | Fix |
|---|---|---|
| Connection refused | Zotero isn't running, or its server is on another port | Open Zotero; check `httpServer.port` |
| `404 No endpoint found` | Plugin not installed or disabled | Tools → Plugins → enable "aiops Zotero MCP" |
| `503` "has no token set" | No token in Zotero | Set `extensions.aiops-zotero-mcp.token` |
| `401` "Missing or wrong bearer token" | Agent's token differs from Zotero's, or the variable is empty | Start the agent from a shell with `ZOTERO_MCP_TOKEN` (`echo ${#ZOTERO_MCP_TOKEN}` prints 64) |
| Connection closed with no reply | The request carried an `Origin` header (a browser); Zotero drops those | Use an MCP client, not a web page |
| Tool result "No item with key ..." | Key from another library, or the item no longer exists | Search again; pass `library_id` for group items |
| Tool result "Invalid arguments for ..." | A parameter is missing or wrong | The message names it; the agent normally retries |

Errors that the agent can fix come back as a tool result marked as an error, so it can correct itself. Unexpected failures are also written to Zotero's error console (Help → Debug Output Logging, or Tools → Developer → Error Console).

## 7. Privacy

Everything stays on this computer between your agent and Zotero. What leaves it is whatever the agent itself sends to its model provider, which includes the text of any item, note or PDF it reads. Leave Zotero's debug output logging off in normal use: when on, Zotero logs request headers, including the token.
