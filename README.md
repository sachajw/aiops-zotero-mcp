# aiops-zotero-mcp

An MCP server that runs **inside Zotero** as a plugin, so AI agents (Claude Code and other MCP clients) can manage and research your Zotero library: find items, read full text and annotations, cite, add and rename files, organise collections and tags, and trash or restore, all through typed tools rather than raw JavaScript.

- **Inside Zotero:** uses Zotero's own JavaScript API, so files, attachments and the trash work the way they do in the app. No debug port, no cloud API, no API key.
- **Localhost only:** served on Zotero's built-in server at `http://127.0.0.1:23119/aiops-mcp`. The plugin opens no socket of its own.
- **Token required:** every request needs `Authorization: Bearer <token>`; with no token set, it refuses everything (503).
- **Safe changes:** every change takes `dry_run: true` to preview it. Nothing is deleted permanently: trashing items or collections is undone by the restore tools, and libraries without a trash are refused.

Tested against Zotero 10.0.9 (macOS); the manifest allows Zotero 7.0 to 10.x.

**Using it:** see [docs/usage.md](docs/usage.md) for connecting an agent, what to ask, dry runs, the full tool reference and troubleshooting.

## Tools

| Tool | What it does |
|---|---|
| `zotero_list_libraries` | My Library and groups, with IDs and whether they're editable |
| `zotero_search_items` | Find by text (title/creator/year, all fields, or everything incl. full text), collection, tags, type; paged |
| `zotero_get_item` | All fields, creators, tags, collections, attachments (and whether each file exists), notes |
| `zotero_list_collections` | Collections with keys, parents and counts |
| `zotero_get_attachment` | One attachment's file details |
| `zotero_get_fulltext` | Text of a PDF/EPUB/snapshot/text attachment, in pages |
| `zotero_get_annotations` | Highlights and notes made in Zotero's reader |
| `zotero_list_notes` | An item's notes as plain text |
| `zotero_cite` | Bibliography or in-text citations in an installed style (apa, chicago, ieee, ...) |
| `zotero_create_collection` / `zotero_update_collection` | Create, rename, move (loops refused) |
| `zotero_trash_collection` / `zotero_restore_collection` | Collection and subcollections to/from the trash; items stay in the library |
| `zotero_create_item` / `zotero_update_item` | Regular items; field names and creator types checked against Zotero's schema |
| `zotero_add_file` | Import or link a local file, under an item or standalone in collections; Zotero's automatic metadata retrieval is suppressed while adding |
| `zotero_rename_attachment` | Title and/or file name; never overwrites |
| `zotero_set_collections` / `zotero_set_tags` | Add/remove collections or tags on many items |
| `zotero_add_note` | Child or standalone note, from plain text or HTML |
| `zotero_trash_items` / `zotero_restore_items` | Items (with their children) to/from the trash |

Items, collections and attachments are addressed by their 8-character Zotero keys.

## Install

1. Build: `mise install && mise run install && mise run build` gives `build/aiops-zotero-mcp-<version>.xpi`.
2. In Zotero: **Tools → Plugins → gear → Install Plugin From File…**, choose the `.xpi`.
3. Create a token and store it in fnox (the value never needs to be shown):
   ```bash
   openssl rand -hex 32 | tr -d '\n' | fnox set ZOTERO_MCP_TOKEN -g -P shell -p keychain -k zotero-mcp-token
   ```
4. Give Zotero the same value: set the preference `extensions.aiops-zotero-mcp.token` (Zotero → Settings → Advanced → Config Editor).
5. Point your MCP client at it, with the token from the environment:
   ```json
   { "type": "http", "url": "http://127.0.0.1:23119/aiops-mcp",
     "headers": { "Authorization": "Bearer ${ZOTERO_MCP_TOKEN}" } }
   ```

The port is Zotero's `httpServer.port` preference (23119 by default).

## Security model

- **Network:** Zotero's server listens on 127.0.0.1 only.
- **Browsers:** Zotero 10 drops any request carrying an `Origin` header before it reaches the plugin; the plugin also answers such requests with 403 itself, as the MCP spec requires (DNS rebinding).
- **Auth:** bearer token, compared in constant time; 401 on a wrong or missing token, 503 while none is configured.
- **Scope:** no tool runs arbitrary code, deletes permanently, empties the trash or touches Zotero settings (apart from switching off automatic metadata retrieval for the duration of `zotero_add_file`).
- **Logs:** with Zotero's debug output switched on, Zotero logs request headers, including the token. Leave debug output off in normal use.

## Develop

```bash
mise install          # node, npm 11, lefthook, commitizen, gitleaks (pinned in mise.toml)
mise run install      # npm ci
mise run check        # typecheck, lint, unit tests, build
fnox exec -P shell -- mise run test:live   # every tool against your running Zotero
```

- **Layout:** `src/mcp/` holds the JSON-RPC/MCP core, `src/http/handler.ts` the transport rules (origin, auth, status codes), `src/tools/` the tools and `src/zotero/` the Zotero helpers and API types. `addon/` holds the plugin manifest, bootstrap and default prefs.
- **Unit tests** cover the protocol, server and HTTP rules and need no Zotero.
- **Live tests** work in a throwaway collection and move what they create to Zotero's trash. They skip when no endpoint or token is available.
- **Commits** follow `.cz.toml` (emoji + LABEL), checked by the commit-msg hook and on GitHub.
- **Versions:** `cz bump` updates `package.json`, and the build stamps that version into the manifest and `updates.json`.
- **npm 11** is pinned because npm 10.9 (bundled with Node 22) crashes resolving vitest 4.1's optional peer dependencies.

## Limits

- **Transport:** stateless JSON responses only. There's no server-to-client stream (GET answers 405), so no progress notifications.
- **Updates:** `update_url` points at `updates.json` in this repo. While the repo is private, Zotero can't fetch it, so updates are manual (install the new `.xpi`).
- **Group libraries:** read and write work where the group is editable, but `zotero_add_file` with `mode: "link"` is limited to My Library (Zotero's rule).
