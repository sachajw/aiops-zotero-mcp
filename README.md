# aiops-zotero-mcp

A Zotero plugin that brings AI to your library in two ways:

1. **An MCP server inside Zotero.** AI agents (Claude Code, the Claude desktop app, any MCP client) can find items, read full text and annotations, cite, add and rename files, organise collections and tags, and trash or restore, all through typed tools rather than raw JavaScript.
2. **An Assistant inside Zotero.** Chat about the paper you're reading, summarise it into a note, get tag and collection suggestions, and ask a Library assistant to reorganise things, approving each change. It works with Claude, OpenAI, OpenRouter, Z.ai, local models (Ollama, LM Studio) or your own gateway.

Tested on Zotero 10.0.9 (macOS); the manifest allows Zotero 7.0 to 10.x. MIT licensed.

## What you need

| You have | Use |
|---|---|
| An AI agent that speaks MCP (Claude Code, Cursor, …) | The MCP server: [Install](#install), then point the agent at it ([docs/usage.md](docs/usage.md)) |
| A Claude subscription, no API key | The MCP server from the Claude desktop app: [docs/usage.md → Claude desktop app](docs/usage.md#claude-desktop-app-uses-your-claude-subscription) |
| An API key: Anthropic, OpenAI, OpenRouter or Z.ai | The Assistant: add the key in Settings ([Assistant → Set up](#set-up)) |
| A local model server (Ollama, LM Studio) | The Assistant, with no key |
| A gateway or proxy on your computer, or Claude-Code-style settings files | The Assistant, through the gateway or the files |
| ChatGPT Business, Enterprise or Edu (Pro read-only) | The MCP server through OpenAI's Secure MCP Tunnel (untested; see [docs/usage.md](docs/usage.md)) |

## How it stays safe

- **Inside Zotero:** the tools use Zotero's own JavaScript API, so files, attachments and the trash behave as they do in the app. No debug port.
- **Localhost only:** the MCP server is an endpoint on Zotero's built-in server, `http://127.0.0.1:23119/aiops-mcp`. The plugin opens no socket of its own.
- **Token required:** every MCP request needs `Authorization: Bearer <token>`; with no token set, it refuses everything (503).
- **Preview first:** every change takes `dry_run: true`. The Assistant only changes your library when you click, through the same tools.
- **Undo:** on Zotero 10, changes to existing items and collections (including related-item links) can be reversed with **Edit → Undo**, labelled as Zotero labels the same change made by hand; a batch is one step.
- **Nothing is deleted permanently:** removal is trash only, undone by the restore tools; libraries without a trash are refused.

## Tools

| Tool | What it does |
|---|---|
| `zotero_list_libraries` | My Library and groups, with IDs and whether they're editable |
| `zotero_search_items` | Find by text (title/creator/year, all fields, or everything incl. full text), collection, tags, type, or items in no collection (`unfiled`); ranked by relevance (title matches first), or sorted by date added, date modified or title; paged in a stable order |
| `zotero_get_item` | All fields, creators, tags, collections, related items, attachments (and whether each file exists), notes |
| `zotero_list_collections` | Collections with keys, full paths and counts; find one by `name` at any depth |
| `zotero_get_attachment` | One attachment's file details |
| `zotero_get_fulltext` | Text of a PDF/EPUB/snapshot/text attachment, in pages; attachments with a missing file are skipped |
| `zotero_get_annotations` | Highlights and notes made in Zotero's reader |
| `zotero_list_notes` | An item's notes as plain text |
| `zotero_cite` | Bibliography or in-text citations in an installed style (apa, chicago, ieee, …) |
| `zotero_create_collection` / `zotero_update_collection` | Create, rename, move (loops refused) |
| `zotero_trash_collection` / `zotero_restore_collection` | Collection and subcollections to/from the trash; items stay in the library |
| `zotero_create_item` / `zotero_update_item` | Regular items; field names and creator types checked against Zotero's schema |
| `zotero_add_file` | Import or link a local file, under an item or standalone in collections; Zotero's automatic metadata retrieval is suppressed while adding |
| `zotero_retrieve_metadata` | Zotero's "Retrieve Metadata for PDF" on standalone PDFs/EPUBs: creates the parent item, reports misses, and returns anything still running after a bounded wait as `pending` (or `failed` if Zotero's run errored) |
| `zotero_rename_attachment` | Title and/or file name; never overwrites |
| `zotero_set_collections` / `zotero_set_tags` | Add/remove collections or tags on many items, all or nothing |
| `zotero_set_related` | Link or unlink items in Zotero's Related section, both ways, as Zotero's Related box does |
| `zotero_add_note` | Child or standalone note, from plain text or HTML |
| `zotero_trash_items` / `zotero_restore_items` | Items (with their children) to/from the trash |

Items, collections and attachments are addressed by their 8-character Zotero keys. Tools reject arguments they don't define, so a misspelled parameter is an error rather than silently ignored. Paged tools return `hasMore` and `nextOffset`. Full reference and worked examples: [docs/usage.md](docs/usage.md).

## Install

1. Get the `.xpi` from the [latest release](https://github.com/sachajw/aiops-zotero-mcp/releases/latest), or build it: `mise install && mise run install && mise run build` gives `build/aiops-zotero-mcp-<version>.xpi`.
2. In Zotero: **Tools → Plugins → gear → Install Plugin From File…**, and choose the `.xpi`.
3. **For the MCP server**, make a token and give Zotero the same value:
   - Generate one, e.g. `openssl rand -hex 32`, and keep it in your secret manager or an environment variable (for example `ZOTERO_MCP_TOKEN`).
   - Set the preference `extensions.aiops-zotero-mcp.token` to it (Zotero → Settings → Advanced → Config Editor).
   - Point your MCP client at the endpoint with the token, e.g.:
     ```json
     { "type": "http", "url": "http://127.0.0.1:23119/aiops-mcp",
       "headers": { "Authorization": "Bearer ${ZOTERO_MCP_TOKEN}" } }
     ```
   The port is Zotero's `httpServer.port` preference (23119 by default). Client-specific steps: [docs/usage.md → Connect an agent](docs/usage.md#2-connect-an-agent).
4. **For the Assistant**, set up a model in Settings: see [Assistant → Set up](#set-up). It doesn't need the MCP token.

### Upgrade

Zotero updates the plugin itself when the plugin's **Allow automatic updates** is On or Default (Default follows Zotero's global setting): it reads `updates.json` from this repo and downloads the release's `.xpi`. To upgrade by hand, install the new `.xpi` the same way; it replaces the old one, Zotero needs no restart, and your settings are kept. Restart your MCP client if it doesn't show new or changed tools (Claude Code reads the tool list only at startup).

A local rebuild that keeps the same version number may not replace the installed file, so remove the plugin first (**⋯ → Remove**) or bump the version. To check what Zotero is running, compare `shasum` of `~/Library/Application Support/Zotero/Profiles/*/extensions/aiops-zotero-mcp@sachajw.github.io.xpi` with your `.xpi`.

## Assistant

The **Assistant** section (sparkle icon in the item pane, also in the PDF reader's side pane, and **Assistant** in the item's right-click menu) has a chat and three actions; **Tools → Library assistant…** opens a chat that can change your library.

**Chat about the item:** the model starts from the item's metadata and the start of its full text, and can read more of it, your annotations and notes, search the rest of the library and format citations. It can't change anything. Replies stream in, formatted (headings, lists, bold, code, tables; links open in your browser). **Stop** cancels, **New chat** starts over, and the backend picker switches backends mid-conversation. Each item keeps its own conversation, saved across restarts.

**Actions:**

| Action | What it does |
|---|---|
| Summarise | A short summary from the metadata and the start of the full text. **Save as note** adds it as a child note, with a footer naming the model, backend, date and how much of the text was read. |
| Suggest tags | Up to 8 tags, matched to your library's existing tags (same spelling). Tags the model made up are listed as "(new tag)" and left unticked. |
| Suggest collection | Up to 3 existing collections by path, with a reason each. |
| Suggest related | Up to 5 items to link in the Related section, chosen from items in the same collections, with the same tags or similar titles, each with a reason; none ticked until you choose. |

Nothing changes until you click **Save as note**, **Add selected tags**, **Add to selected** or **Link selected**.

**Library assistant** (also: right-click a collection → *Ask the library assistant about this collection…*): searches the whole library and makes changes: files items, adds or removes tags, links related items, adds notes, creates or renames collections, edits fields, trashes and restores. Each change is first run as a dry run and shown as a card, with keys resolved to titles and collection paths; it runs only when you click **Approve**. **Reject** tells the model you declined; **Stop** cancels the turn and any waiting change (a change you already approved stays, and the model remembers it). It can't add files from disk or retrieve metadata from zotero.org.

### Set up

Zotero → Settings → **Zotero MCP Assistant**. Set up as many backends as you like; the **Backends** list has **Use**, **Test** and **Remove** for each.

**Add a provider** (most people):

1. Choose a preset:
   - **Anthropic**, **OpenAI**, **OpenRouter**, **Z.ai**: paste your API key.
   - **Ollama**, **LM Studio**: a model server on this computer; no key.
   - **Local gateway or proxy**: e.g. one that signs in to a subscription; key optional.
   - **Other**: any https endpoint (or http on this computer) that speaks one of the two APIs.
2. Check the filled-in URL, API format (Anthropic Messages or OpenAI chat completions) and key type, and enter model IDs from your provider's model list. OpenAI-format presets leave the models blank on purpose, so they're never out of date.
3. **Save**, then **Test** it in the Backends list.

The key goes in Zotero's password store, never in preferences. It's encrypted on disk, and protected by a password only if you set a primary password.

**Or use Claude-Code-style settings files** (a local proxy, or files you already use for Claude Code): list their paths under **Settings files**. Each is JSON with an `env` block: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` (sent as `x-api-key`) and/or `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer`), and `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`. The file is read on every request, so a rotated key or changed model applies at once.

The plugin never uses a Claude, ChatGPT or other subscription itself: it sends the key you configure, or nothing to a local server or proxy that handles sign-in.

### Which model is used

There are two settings, one for each kind of use:

| Setting | Used by | Default |
|---|---|---|
| **Chat model** | The item chat and the Library assistant | `sonnet` |
| **Actions model** | Summarise, Suggest tags, Suggest collection, Suggest related | `sonnet` |

Each is either a **tier** (`default`, `opus`, `sonnet`, `haiku`) or an exact model ID. A tier means "this backend's model for that tier", so the same setting picks the right model on every backend:

- **Providers added in Settings:** the models you entered under **Models** when adding it (default, opus, sonnet, haiku); an empty tier falls back to its default model.
- **Settings files:** `ANTHROPIC_DEFAULT_OPUS_MODEL`, `…_SONNET_MODEL`, `…_HAIKU_MODEL`, and `ANTHROPIC_MODEL` for `default` (and for any tier the file doesn't set).

For each backend, the first of these that's set wins: its own row in Settings → **Models** (`chatModel.<backend>`, `actionModel.<backend>`), then the shared setting, then the default above.

Example: with the shared chat model `sonnet`, **claude → chat** set to `opus` and **zai → chat** set to `default`, chats on Claude use its opus model, chats on Z.ai use its default model, and any other backend uses its sonnet model; the actions use each backend's sonnet model.

**Why `sonnet` for the actions.** Before v0.13.1 the default was `haiku`, which is faster but gave the least accurate suggestions on Claude. In a comparison on 5 books (Suggest collection and Suggest related; Zotero 10.0.9, November 2026):

| Backend | Model | Result | Suggest related, time per item |
|---|---|---|---|
| Claude | `claude-haiku-5-5` | All 5 collection picks wrong; related picks loosely matched | 2–4 s |
| Claude | `claude-sonnet-5-5` | All accurate | 3–7 s |
| Claude | `claude-opus-5-5` | All accurate, slightly sharper related picks | 5–9 s |
| Z.ai | `glm-4.5-air` | Accurate | 8–10 s |
| Z.ai | `glm-4.7` | One clear filing error | 4–8 s |
| Z.ai | `glm-5.3` | Sharpest related picks | 13–20 s |

So the Z.ai preset now maps `sonnet` (as well as `default` and `opus`) to glm-5.3; a Z.ai provider saved before v0.13.1 keeps the models it was saved with. Set **actions** to `haiku` if speed matters more, or `opus` for the sharpest Claude suggestions. Compare each provider on its own: one provider's results don't carry over to another.

To see which model answered: chat replies end with "*model* via *backend*", action results start with "From *model* via *backend*", and **Test** in the Backends list reports the chat model. The MCP endpoint itself uses no model: agents that call its tools use their own.

### Preferences

All are under `extensions.aiops-zotero-mcp.llm.` in the Config Editor; the Settings pane covers the main ones.

| Preference | Default | Meaning |
|---|---|---|
| `backends` | `[]` | Providers added in Settings (name, URL, format, key type, models; never the key) |
| `profileFiles` | empty | Absolute paths to settings files, one per line or comma-separated |
| `activeProfile` | the first backend | The backend in use, by name (a provider's name, or a settings file's name without `.settings.json`) |
| `chatModel`, `actionModel` | `sonnet`, `sonnet` | Model for the chats and the actions: a tier or a model ID |
| `chatModel.<backend>`, `actionModel.<backend>` | unset | The same, for one backend only |
| `maxToolIterations` | 10 | Rounds of tool calls a chat may make before it must answer |
| `maxToolResultChars` | 20000 | Most characters of one tool result the model sees |
| `maxTokens` | 4096 | Reply cap, including any thinking the model does first |
| `contextChars` | 60000 | Characters of full text sent with an item (max 100000) |
| `requestTimeoutSeconds` | 120 | |

### Data and privacy

- **Keys only travel encrypted:** a backend's URL must be `https://`, or plain `http://` to this computer only (`127.0.0.1`, `localhost`, `[::1]`).
- **What leaves Zotero:** the item's metadata and the start of its full text, sent to the backend you chose; for tag and collection suggestions, your tag names and collection paths; in the chats, whatever their tools return (more text, annotations, notes, search results, change previews).
- **Saved conversations:** each chat is saved after every turn as a JSON file in `aiops-zotero-mcp/chats/` inside your Zotero data directory. They hold excerpts of your library, stay on this computer, and aren't synced. **New chat** deletes that conversation's file, and so does deleting the item permanently (trashing keeps it, since the item can come back).
- **Tested backends:** Claude (`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`) and Z.ai (`glm-4.5-air`, `glm-4.7`, `glm-5.3`) in Anthropic format, and an OpenAI-compatible gateway in OpenAI format. Not yet tested against api.openai.com, OpenRouter, Ollama or LM Studio themselves.

## Security model

- **Network:** Zotero's server listens on 127.0.0.1 only.
- **Browsers:** Zotero 10 drops any request carrying an `Origin` header before it reaches the plugin; the plugin also answers such requests with 403 itself, as the MCP spec requires (DNS rebinding).
- **Auth:** bearer token, compared in constant time; 401 on a wrong or missing token, 503 while none is configured.
- **Scope:** no tool runs arbitrary code, deletes permanently, empties the trash or touches Zotero settings (apart from switching off automatic metadata retrieval for the duration of `zotero_add_file`).
- **Assistant:** keys only over https or to this computer; stored in Zotero's password store (or read from your own settings files); model output is never parsed as markup; the library changes only through the same tools, after a click.
- **Logs:** with Zotero's debug output switched on, Zotero logs request headers, including the token. Leave debug output off in normal use.

## Develop

```bash
mise install          # node, npm 11, lefthook, commitizen, gitleaks (pinned in mise.toml)
mise run install      # npm ci
mise run check        # typecheck, lint, unit tests, build (what CI runs)
mise run test:live    # live tests; needs ZOTERO_MCP_TOKEN and/or the AIOPS_LLM_* variables
```

- **Layout:** `src/http/` and `src/mcp/` are the MCP transport and core, `src/tools/` the tools, `src/zotero/` the Zotero helpers and API types, `src/assistant/` the model clients and agent loop (pure, unit-tested), `src/ui/` the item pane, menus, windows and chat. `addon/` holds the manifest, bootstrap, default prefs, the Settings pane and the Fluent strings.
- **Unit tests** need no Zotero. One file: `npx vitest run tests/unit/agent.test.ts`; by name: `npx vitest run tests/unit -t "<name>"`.
- **Live tests:** `tests/live/library.test.ts` runs every tool against a running Zotero (needs `ZOTERO_MCP_TOKEN`) in a throwaway collection, trashing what it creates; `tests/live/assistant.test.ts` runs the Assistant's prompts, streaming and approval gate against real models (`AIOPS_LLM_PROFILE_FILES`, or `AIOPS_LLM_OPENAI_URL` / `_MODEL` / `_KEY`). Each skips when its variables are missing.
- **Commits** follow `.cz.toml` (emoji + LABEL), checked by the commit-msg hook and on GitHub.
- **Releases:** `cz bump` (updates `package.json`, `updates.json` and `CHANGELOG.md`, tags `vX.Y.Z`), `mise run build`, push the commit and tag, then `gh release create vX.Y.Z build/aiops-zotero-mcp-X.Y.Z.xpi`. Push and publish together: installed copies update from `updates.json` on `main`, which points at that release asset.
- **Agents:** `CLAUDE.md` describes the architecture and conventions for Claude Code.
- **npm 11** is pinned because npm 10.9 (bundled with Node 22) crashes resolving vitest 4.1's optional peer dependencies.

## Limits

- **Transport:** stateless JSON responses only. There's no server-to-client stream (GET answers 405), so no progress notifications. Long `zotero_retrieve_metadata` runs return `pending` items instead; check them later with `zotero_get_item`.
- **Search ranking:** relevance is scored from the fields Zotero shows (title, creators, year, publication, tags, and in `all_fields` / `everything` the other fields). An item that matched only in its full text, notes or annotations sorts after every field match, not by how often the words appear there.
- **Group libraries:** read and write work where the group is editable, but `zotero_add_file` with `mode: "link"` is limited to My Library (Zotero's rule).
- **Undo:** creating items, collections or notes and adding files aren't undoable in Zotero (trash them instead); renaming an attachment's file on disk isn't either, though its title is.
- **Optional:** `extensions.aiops-zotero-mcp.retrieveMetadataWaitSeconds` (default 45) is how long `zotero_retrieve_metadata` waits before returning; keep it under your MCP client's tool timeout.

## License

[MIT](LICENSE)
