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

Ask in plain language; the agent picks the tools. Some examples across a library (section 6 shows real calls and replies):

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

### Retrieving metadata

`zotero_retrieve_metadata` runs Zotero's own "Retrieve Metadata for PDF" on standalone PDF or EPUB attachments.

- Zotero sends text from the first pages to its metadata service at zotero.org, looks up the DOI, ISBN or arXiv ID it finds, creates a parent item in the attachment's collections and moves the attachment under it.
- The file may be renamed to match, depending on your Zotero file-renaming setting.
- The reply gives each attachment a `status`: `recognized` (with the new parent), `not_recognized` (with the reason, for example a scanned PDF with no text), `pending`, or `failed` (Zotero's metadata retrieval stopped with an error before reaching it; the reason gives the error, and retrying is safe).
- The call waits at most `extensions.aiops-zotero-mcp.retrieveMetadataWaitSeconds` (45 by default; set it in Zotero → Settings → Advanced → Config Editor). Anything Zotero hasn't finished by then is `pending`: it keeps running in Zotero, so check it later with `zotero_get_item` instead of sending it again. Keep the wait under your MCP client's tool timeout. Big PDFs and ISBN lookups that the catalogue is throttling are the slow ones.
- Attachments that already have a parent, are not PDFs or EPUBs, or are in the trash are refused before anything runs. It is refused while Zotero is offline.
- To undo, use the undo entry on the new parent's context menu in Zotero. It is offered for 24 hours, until the parent is edited or Zotero restarts.

### Reading long texts

`zotero_get_fulltext` returns up to `max_chars` (default 20,000) and tells you the next `offset` (also as `hasMore`/`nextOffset` in the data, as `zotero_search_items` does). The agent can page through a whole book. An attachment whose file is missing is skipped, so a parent item's next attachment is tried. Text comes from Zotero's full-text index, or is extracted from the PDF if it has not been indexed yet.

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
| `zotero_retrieve_metadata` | `item_keys`\* (standalone PDF/EPUB attachments, up to 50) |
| `zotero_rename_attachment` | `item_key`\*, `title`, `filename` (extension kept if omitted; never overwrites; if the file is renamed but the title save fails, the error says so) |
| `zotero_set_collections` | `item_keys`\*, `add` [], `remove` [] |
| `zotero_set_tags` | `item_keys`\*, `add` [], `remove` [] |
| `zotero_add_note` | `text`\*, `format` [`text`] \| `html`, `parent_item_key`, `collection_keys` |
| `zotero_trash_items` | `item_keys`\* |
| `zotero_restore_items` | `item_keys`\* |
| `zotero_trash_collection` | `collection_key`\* |
| `zotero_restore_collection` | `collection_key`\* |

Creators are `{"creator_type": "author", "first_name": "Ada", "last_name": "Lovelace"}` or `{"creator_type": "author", "name": "Example Org"}`. Field names and creator types are checked against Zotero's schema for the item type; a wrong one comes back with the list of valid ones.

## 6. Worked examples

Real calls and replies, recorded against Zotero 10.0.9 on 2026-11-14 in a throwaway collection with two test items (since trashed). Item keys are from that run, so yours will differ. `<tmp>` stands for a temporary folder. In normal use you only type the request; the agent makes the calls.

Setup for these examples: a collection "Worked examples" holding a journal article ("Attention Is All You Need", Vaswani & Shazeer, 2017) with a short text file as its full text, and a book ("Deep Learning", Goodfellow, Bengio & Courville, 2016).

### 6.1 Find a paper and read it

> Find the attention paper in my Worked examples collection and read it to me.

**`zotero_search_items`**

```json
{
  "query": "attention",
  "collection_key": "2DJYJFH6"
}
```

Reply:

```text
1 matching item; showing 1 from offset 0

{
  "total": 1,
  "offset": 0,
  "hasMore": false,
  "nextOffset": null,
  "items": [
    {
      "key": "BFRPRRB9",
      "itemType": "journalArticle",
      "title": "Attention Is All You Need",
      "creators": [
        "Ashish Vaswani",
        "Noam Shazeer"
      ],
      "date": "2017",
      "attachments": 1,
      "notes": 0
    }
  ]
}
```

**`zotero_get_item`**

```json
{
  "item_key": "BFRPRRB9"
}
```

Reply:

```text
journalArticle BFRPRRB9: Attention Is All You Need

{
  "key": "BFRPRRB9",
  "version": 0,
  "itemType": "journalArticle",
  "title": "Attention Is All You Need",
  "date": "2017",
  "volume": "30",
  "publicationTitle": "Advances in Neural Information Processing Systems",
  "creators": [
    {
      "firstName": "Ashish",
      "lastName": "Vaswani",
      "creatorType": "author"
    },
    {
      "firstName": "Noam",
      "lastName": "Shazeer",
      "creatorType": "author"
    }
  ],
  "tags": [
    {
      "tag": "transformers"
    }
  ],
  "dateAdded": "2026-11-14T19:33:03Z",
  "dateModified": "2026-11-14T19:33:03Z",
  "libraryID": 1,
  "collectionKeys": [
    "2DJYJFH6"
  ],
  "inTrash": false,
  "attachments": [
    {
      "key": "8DFQYVF7",
      "title": "Full text",
      "filename": "attention-notes.txt",
      "contentType": "text/plain",
  … (trimmed)
```

**`zotero_get_fulltext`**

```json
{
  "item_key": "BFRPRRB9",
  "max_chars": 120
}
```

Reply:

```text
Text of 8DFQYVF7 (attention-notes.txt): characters 0–120 of 272. More: offset 120.

{
  "attachmentKey": "8DFQYVF7",
  "totalChars": 272,
  "offset": 0,
  "hasMore": true,
  "nextOffset": 120,
  "text": "Example text standing in for the paper. The Transformer is based solely on attention mechanisms, dispensing with recurre"
}
```

**`zotero_get_fulltext`**

```json
{
  "item_key": "BFRPRRB9",
  "offset": 120,
  "max_chars": 200
}
```

Reply:

```text
Text of 8DFQYVF7 (attention-notes.txt): characters 120–272 of 272.

{
  "attachmentKey": "8DFQYVF7",
  "totalChars": 272,
  "offset": 120,
  "hasMore": false,
  "nextOffset": null,
  "text": "nce and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable."
}
```

The reader pages through long texts with `offset`; the first reply says where to continue.

### 6.2 Cite

> Give me an APA bibliography of both, then the in-text citations. Then try Vancouver.

**`zotero_cite`**

```json
{
  "item_keys": [
    "BFRPRRB9",
    "4AILHTX2"
  ],
  "style": "apa"
}
```

Reply:

```text
bibliography in APA Style 7th edition, text:

Goodfellow, I., Bengio, Y., & Courville, A. (2016). Deep Learning. MIT Press.
Vaswani, A., & Shazeer, N. (2017). Attention Is All You Need. Advances in Neural Information Processing Systems, 30.
```

**`zotero_cite`**

```json
{
  "item_keys": [
    "BFRPRRB9",
    "4AILHTX2"
  ],
  "kind": "citation",
  "style": "apa"
}
```

Reply:

```text
citation in APA Style 7th edition, text:

(Vaswani & Shazeer, 2017)
(Goodfellow et al., 2016)
```

**`zotero_cite`**

```json
{
  "item_keys": [
    "4AILHTX2"
  ],
  "style": "vancouverish"
}
```

Reply (reported as an error):

```text
Style "vancouverish" is not installed. Installed: american-chemical-society, american-medical-association, apa, american-political-science-association, american-sociological-association, chicago-author-date, chicago-notes-bibliography, chicago-shortened-notes-bibliography, harvard-cite-them-right, elsevier-harvard, ieee, mhra-notes, modern-language-association, nature, nlm-citation-sequence
```

An unknown style is an error the agent can act on: the reply lists the styles installed in your Zotero.

### 6.3 Add a file to an item and give it a sensible name

> Attach scan_0042.txt to the Deep Learning book, show me first, then call it "Chapter 1" and rename the file goodfellow-2016-chapter-1.

**`zotero_add_file`**

```json
{
  "path": "<tmp>/scan_0042.txt",
  "parent_item_key": "4AILHTX2",
  "dry_run": true
}
```

Reply:

```text
Dry run, nothing changed. Would import scan_0042.txt

{
  "path": "<tmp>/scan_0042.txt",
  "mode": "import",
  "title": "scan_0042.txt",
  "bytes": 21,
  "parentKey": "4AILHTX2",
  "collectionKeys": []
}
```

**`zotero_add_file`**

```json
{
  "path": "<tmp>/scan_0042.txt",
  "parent_item_key": "4AILHTX2"
}
```

Reply:

```text
Added KVKWR7QT

{
  "key": "KVKWR7QT",
  "title": "scan_0042.txt",
  "filename": "scan_0042.txt",
  "contentType": "text/plain",
  "linkMode": "imported_file",
  "fileExists": true,
  "inTrash": false
}
```

**`zotero_rename_attachment`**

```json
{
  "item_key": "KVKWR7QT",
  "title": "Chapter 1",
  "filename": "goodfellow-2016-chapter-1"
}
```

Reply:

```text
Renamed KVKWR7QT

{
  "before": {
    "title": "scan_0042.txt",
    "filename": "scan_0042.txt"
  },
  "after": {
    "key": "KVKWR7QT",
    "title": "Chapter 1",
    "filename": "goodfellow-2016-chapter-1.txt",
    "contentType": "text/plain",
    "linkMode": "imported_file",
    "fileExists": true,
    "inTrash": false
  }
}
```

The file name kept its extension (`.txt`) because none was given. Renaming never overwrites an existing file.

### 6.4 Reorganise, previewing first

> Make a "To read" subcollection, move the book into it out of Worked examples, and tag both items review. Preview the move first.

**`zotero_create_collection`**

```json
{
  "name": "To read",
  "parent_key": "2DJYJFH6"
}
```

Reply:

```text
Created collection T2M4XIYS "To read"

{
  "key": "T2M4XIYS",
  "name": "To read",
  "parentKey": "2DJYJFH6",
  "items": 0,
  "subcollections": 0
}
```

**`zotero_set_collections`**

```json
{
  "item_keys": [
    "4AILHTX2"
  ],
  "add": [
    "T2M4XIYS"
  ],
  "remove": [
    "2DJYJFH6"
  ],
  "dry_run": true
}
```

Reply:

```text
Dry run, nothing changed. Would change collections of 1 item

{
  "items": [
    "4AILHTX2"
  ],
  "add": [
    "T2M4XIYS To read"
  ],
  "remove": [
    "2DJYJFH6 Worked examples"
  ]
}
```

**`zotero_set_collections`**

```json
{
  "item_keys": [
    "4AILHTX2"
  ],
  "add": [
    "T2M4XIYS"
  ],
  "remove": [
    "2DJYJFH6"
  ]
}
```

Reply:

```text
Updated collections of 1 item

{
  "items": [
    "4AILHTX2"
  ],
  "add": [
    "T2M4XIYS To read"
  ],
  "remove": [
    "2DJYJFH6 Worked examples"
  ]
}
```

**`zotero_set_tags`**

```json
{
  "item_keys": [
    "BFRPRRB9",
    "4AILHTX2"
  ],
  "add": [
    "review"
  ]
}
```

Reply:

```text
Updated tags on 2 items

{
  "items": [
    "BFRPRRB9",
    "4AILHTX2"
  ],
  "add": [
    "review"
  ],
  "remove": []
}
```

> What would change if I set the book's edition to 1 and the publisher to The MIT Press?

**`zotero_update_item`**

```json
{
  "item_key": "4AILHTX2",
  "fields": {
    "edition": "1",
    "publisher": "The MIT Press"
  },
  "dry_run": true
}
```

Reply:

```text
Dry run, nothing changed. Would update 4AILHTX2

{
  "changes": [
    {
      "field": "edition",
      "from": "",
      "to": "1"
    },
    {
      "field": "publisher",
      "from": "MIT Press",
      "to": "The MIT Press"
    }
  ]
}
```

A wrong field name is caught before anything changes, with the valid fields for that item type:

**`zotero_create_item`**

```json
{
  "item_type": "book",
  "fields": {
    "journal": "x"
  },
  "dry_run": true
}
```

Reply (reported as an error):

```text
Not fields of book: journal. Valid: title, abstractNote, series, seriesNumber, volume, numberOfVolumes, edition, date, publisher, place, originalDate, originalPublisher, originalPlace, format, numPages, ISBN, DOI, citationKey, url, accessDate, ISSN, archive, archiveLocation, shortTitle, language, libraryCatalog, callNumber, rights, extra
```

### 6.5 Trash and restore

> Trash the attention paper. … Actually, bring it back.

**`zotero_trash_items`**

```json
{
  "item_keys": [
    "BFRPRRB9"
  ],
  "dry_run": true
}
```

Reply:

```text
Dry run, nothing changed. Would move 1 item to the trash

[
  {
    "key": "BFRPRRB9",
    "itemType": "journalArticle",
  … (trimmed)
```

**`zotero_trash_items`**

```json
{
  "item_keys": [
    "BFRPRRB9"
  ]
}
```

Reply:

```text
Moved 1 item to the trash (restore with zotero_restore_items)

[
  {
    "key": "BFRPRRB9",
    "itemType": "journalArticle",
  … (trimmed)
```

**`zotero_search_items`**

```json
{
  "query": "attention",
  "collection_key": "2DJYJFH6",
  "include_trashed": true
}
```

Reply:

```text
1 matching item; showing 1 from offset 0

{
  "total": 1,
  "offset": 0,
  "hasMore": false,
  "nextOffset": null,
  "items": [
    {
      "key": "BFRPRRB9",
      "itemType": "journalArticle",
      "title": "Attention Is All You Need",
      "creators": [
        "Ashish Vaswani",
        "Noam Shazeer"
      ],
      "date": "2017",
      "attachments": 1,
      "notes": 0,
      "inTrash": true
    }
  ]
}
```

**`zotero_restore_items`**

```json
{
  "item_keys": [
    "BFRPRRB9"
  ]
}
```

Reply:

```text
Restored 1 item

[
  {
    "key": "BFRPRRB9",
    "itemType": "journalArticle",
  … (trimmed)
```

Trashed items drop out of searches unless `include_trashed` is set, where they show `"inTrash": true`. Nothing is erased: the trash is only emptied from Zotero itself.

## 7. When something fails

| You see | Meaning | Fix |
|---|---|---|
| Connection refused | Zotero isn't running, or its server is on another port | Open Zotero; check `httpServer.port` |
| `404 No endpoint found` | Plugin not installed or disabled | Tools → Plugins → enable "aiops Zotero MCP" |
| `503` "has no token set" | No token in Zotero | Set `extensions.aiops-zotero-mcp.token` |
| `401` "Missing or wrong bearer token" | Agent's token differs from Zotero's, or the variable is empty | Start the agent from a shell with `ZOTERO_MCP_TOKEN` (`echo ${#ZOTERO_MCP_TOKEN}` prints 64) |
| Connection closed with no reply | The request carried an `Origin` header (a browser); Zotero drops those | Use an MCP client, not a web page |
| Tool result "No item with key ..." | Key from another library, or the item no longer exists | Search again; pass `library_id` for group items |
| Tool result "Invalid arguments for ..." | A parameter is missing or wrong, or not a parameter of that tool ("Unrecognized key", e.g. a misspelling) | The message names it; the agent normally retries |

Errors that the agent can fix come back as a tool result marked as an error, so it can correct itself. Unexpected failures are also written to Zotero's error console (Help → Debug Output Logging, or Tools → Developer → Error Console).

## 8. Privacy

Everything stays on this computer between your agent and Zotero. What leaves it is whatever the agent itself sends to its model provider, which includes the text of any item, note or PDF it reads. Leave Zotero's debug output logging off in normal use: when on, Zotero logs request headers, including the token.
