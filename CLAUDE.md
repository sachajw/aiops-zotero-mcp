# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

An MCP server that runs **inside Zotero** as a bootstrapped plugin (Zotero 7.0–10.x, tested on 10.0.9). It registers an endpoint on Zotero's own HTTP server at `http://127.0.0.1:23119/aiops-mcp` and exposes typed tools over Zotero's JavaScript API. User-facing docs: `README.md` and `docs/usage.md` (tool reference, troubleshooting).

## Commands

Tools are pinned in `mise.toml` (node 22, npm 11, lefthook, commitizen, gitleaks). npm 11 is required: npm 10.9 crashes resolving vitest 4.1's optional peers.

```bash
mise install && mise run install    # toolchain, then npm ci (first build fails on missing esbuild without this)
mise run check                      # typecheck + lint + unit tests + build: what CI runs
mise run build                      # build/aiops-zotero-mcp-<version>.xpi (version from package.json)
npx vitest run tests/unit/server.test.ts        # one unit test file
npx vitest run tests/unit -t "constantTimeEqual" # tests matching a name
fnox exec -P shell -- mise run test:live         # every tool against the running Zotero
```

- **Live tests** (`tests/live/`) need the plugin installed in a running Zotero and `ZOTERO_MCP_TOKEN` (from fnox), and optionally `ZOTERO_MCP_URL`. Without them they skip; they don't fail, so check the summary says `passed`, not `skipped`. They work in a throwaway collection and trash what they create. CI runs only the unit tests.
- **Trying a change in Zotero:** rebuild, then reinstall the `.xpi` (Tools → Plugins → Install Plugin From File, or the zotero-dev MCP `zotero_plugin_install`). Reinstalling replaces the running plugin; restart the MCP client connection afterwards if tools are missing (Claude Code reads the tool list only at startup). To confirm which build Zotero is running, compare `shasum` of `~/Library/Application Support/Zotero/Profiles/*/extensions/aiops-zotero-mcp@sachajw.github.io.xpi` with the one in `build/`; a rebuild that keeps the same version number may not replace the installed file, so remove the plugin first or bump the version.
- `typecheck` covers `src/` only (`tsconfig.json` include); tests are type-checked by vitest, not tsc.

## Architecture

Request path: `addon/bootstrap.js` → `src/index.ts` → `src/http/handler.ts` → `src/mcp/server.ts` → a tool in `src/tools/`.

- **Bootstrap/bundle:** `scripts/build.mjs` bundles `src/index.ts` with esbuild into an IIFE (`globalName: AiopsZoteroMcp`, target firefox128), which `bootstrap.js` loads with `loadSubScriptWithOptions({ ignoreCache: true })` (the startup cache would otherwise serve a previous version's bundle after an upgrade) and calls `start()`/`stop()`. The build also stamps the version into `addon/manifest.json` (`__VERSION__`), writes `build/updates.json`, and zips with fflate using sorted paths and a fixed mtime, so builds are reproducible. Don't shell out to `zip`.
- **Endpoint registration (`src/index.ts`):** adds `Zotero.Server.Endpoints["/aiops-mcp"]` plus missing reason phrases (401/405/202), and removes both in `stop()`. The plugin opens no socket of its own.
- **Transport (`src/http/handler.ts`):** stateless, JSON-only MCP Streamable HTTP. Checks run in this order before the body is read: `Origin` present → 403 (DNS-rebinding guard); no token configured → 503; wrong token → 401 (constant-time compare). GET answers 405, so there's no server stream and no progress notifications.
- **MCP core (`src/mcp/`):** `protocol.ts` holds JSON-RPC types and protocol-version negotiation; `server.ts` handles `initialize`, `ping`, `tools/list` and `tools/call`. Tool input is validated with the tool's zod schema; `tools/list` publishes `z.toJSONSchema` output.
- **Tools (`src/tools/read.ts`, `write.ts`):** each one is a `defineTool({...})` (`src/mcp/tool.ts`). To add a tool, define it and append it to the `readTools`/`writeTools` array at the bottom of the file. Conventions:
  - Return `{ summary, data }`; the server serialises it as text: summary, a blank line, then pretty JSON (`src/mcp/server.ts`). The live tests parse `data` by splitting on that first blank line, so keep summaries to one paragraph. Paged tools add `hasMore`/`nextOffset` with `nextPage` (`library.ts`).
  - A new tool also needs a row in the README tools table, an entry in `docs/usage.md` §5 (Tool reference), and coverage in `tests/live/library.test.ts`.
  - `defineTool` makes every input schema strict: unknown keys are a validation error and `tools/list` publishes `additionalProperties: false`. Don't bypass it with `.passthrough()`/`.loose()`.
  - Throw `ToolError` for anything the caller can fix: it becomes an `isError` result the model can act on. Other exceptions are also returned as errors but logged with `Zotero.logError`.
  - Write tools take `zDryRun` and return `dryRunResult(...)` before changing anything; take `zLibraryID` and resolve it with `libraryOf(id, { write: true })`.
  - Nothing deletes permanently: removal is trash only (`requireTrash`), and restore tools undo it. No tool runs arbitrary JS or changes Zotero settings, except that `zotero_add_file` switches off `autoRecognizeFiles` while adding and restores it afterwards.
  - Validate everything before the first mutation (e.g. `validateItemData` checks fields and creator types against Zotero's schema).
  - A tool that changes several items saves them with `saveAllOrNone` (`write.ts`): one `Zotero.DB.executeTransaction` with `item.save()` inside, so a failure rolls back the whole batch. Don't loop over `saveTx()`, which commits each item separately.
  - Tool calls can overlap (clients call tools in parallel). Anything that temporarily changes shared state, such as a pref, goes through `suspender` (`src/zotero/suspend.ts`), which saves the value on the first entry and restores it on the last exit. A plain save/`finally`-restore loses the user's value when calls overlap.
  - `Zotero.Search.search()` has no `ORDER BY`; sort the IDs before applying `offset`/`limit`.
  - Zotero getters can throw where you'd expect an empty value: `attachmentText` throws for a PDF whose file is missing, so check `getFilePathAsync()` + `IOUtils.exists` first. If a tool makes two separate changes (file rename, then title save), a failure after the first must say what already changed.
- **Zotero helpers (`src/zotero/library.ts`):** shared zod pieces (`zKey`, `zLibraryID`, `zDryRun`), lookups that throw `ToolError`, and the plain-object views (`itemSummary`, `itemDetail`, `attachmentView`, `collectionView`). Anything returned to a client goes through these views, never raw Zotero objects.
- **Zotero API types (`src/zotero/globals.d.ts`):** a hand-written, minimal declaration of the `Zotero` global covering only what the code uses. When calling a new Zotero API, add it here; check that it exists in the running Zotero first (e.g. with the zotero-dev MCP `zotero_execute_js`/`zotero_inspect_object`) rather than guessing.
- **Config is Zotero prefs** (defaults in `addon/prefs.js`), read at call time: `extensions.aiops-zotero-mcp.token` (bearer token) and `extensions.aiops-zotero-mcp.retrieveMetadataWaitSeconds` (how long `zotero_retrieve_metadata` waits before reporting unfinished items as `pending`; Zotero keeps processing them. If the run itself throws, unfinished items are `failed` instead: see `unfinishedOutcome`).
- **Assistant (`src/assistant/`, `src/ui/`):** in-Zotero item chat and actions (summarise, suggest tags, suggest collections) against a local Anthropic-Messages proxy.
  - Chat: `agent.ts` runs the tool loop (pure; send and tools injected), sequential tool calls, results capped and returned in order, `tool_choice: none` on the last allowed round so it must answer. Write tools are gated (dry run, approve, run the frozen previewed args); the item chat gets read tools only (`toolset.ts`, which also never offers `zotero_add_file` / `zotero_retrieve_metadata`). `sse.ts` builds streamed replies.
  - Keep `thinking` / `redacted_thinking` blocks (with signature) in the history unchanged: Claude replies empty on the next turn without them. Strip them when the backend changes (signed by the backend that wrote them). `ui/chat.ts` does both.
  - "uncaught exception: undefined" in the error console on every install, enable or disable is Zotero's, not ours: shipping `locale/` makes Zotero update the shared plugin L10n source, Firefox re-translates every window, and four of Zotero's own main-window buttons (`browser-window-{minimize,maximize,restore-down,close}-button`, strings in an unshipped `browser/menubar.ftl`) fail, rejecting with undefined. Reproduce: `L10nRegistry.getInstance().updateSources([...])`, or `document.l10n.translateRoots()` on the main window. Our strings translate fine.
  - Library assistant: `ui/window.ts` opens `chrome://aiops-zotero-mcp/content/assistant.xhtml` (bootstrap.js registers that chrome package; Zotero won't load a jar: URL as a window) and mounts the same chat with `writes: true`. `ui/chat.ts` shows the approval card from the agent's `approve` callback; Stop or closing the window refuses a pending change. Attach the window's unload listener only after load: the initial about:blank page fires unload too.
  - Settings pane: `addon/static/preferences.{xhtml,js}`, registered with `Zotero.PreferencePanes.register`; its Test connection button calls `Zotero.AiopsZoteroMcp.testConnection`, set while the plugin runs.
  - `config.ts` reads `extensions.aiops-zotero-mcp.llm.*` prefs and the Claude-Code-style settings file they point at, on every request; base URLs must be loopback (`assertLoopback`). `transport.ts` sends non-streaming requests; fetch and AbortController are injected (the plugin sandbox has `fetch` but no `AbortController`, so Zotero passes the main window's).
  - `actions.ts` is pure: prompts, and parsing proposals from the forced `propose_*` tool or the same JSON as reply text (some GLM models ignore forced `tool_choice`; reasoning models need `maxTokens`, not a small cap, because thinking counts against it). Suggestions are filtered against what exists.
  - The model never writes. `ui/assistant.ts` applies what the user ticks through `runTool` (`src/mcp/runner.ts`, shared with the MCP server) on the write tools: dry run, then the real call. Render model and document text with `textContent` only (privileged window).
  - `src/assistant/zotero.ts` and `src/ui/` touch Zotero; unit tests don't import them. Live: `AIOPS_LLM_PROFILE_FILES=... npx vitest run tests/live/assistant.test.ts` (optionally `AIOPS_LLM_MODEL=sonnet`).
  - Zotero UI APIs used (`ItemPaneManager.registerSection`, `MenuManager.registerMenu`, Fluent `locale/en-US/aiops-zotero-mcp.ftl`, icons in `addon/static/`) are typed in `globals.d.ts` under `ZoteroUI`. A section's `onRender` runs with `item` undefined when nothing is selected.
- **Unit tests** import `src/` directly with no `Zotero` global, so code that unit tests reach must not touch `Zotero` at module load or in default parameters. Put Zotero reads inside `run()` and test the pure part (see `parseWaitSeconds`), or inject them as functions (see `suspender` and `tests/unit/suspend.test.ts`).

## Commits and releases

- Commit messages follow `.cz.toml`: `<emoji> <LABEL>: <description>`, e.g. `🐛 FIX: ...`, `✨ FEATURE: ...`. The lefthook `commit-msg` hook and `.github/workflows/commitizen.yml` both enforce it. Pre-commit runs gitleaks, eslint and `tsc --noEmit`.
- Release with `cz bump`: it bumps `package.json` and `updates.json`, updates `CHANGELOG.md`, and commits as `🚀 RELEASE: vX.Y.Z` with tag `vX.Y.Z`. `manifest.json` gets the version at build time. Then `mise run build`, `git push --follow-tags`, and `gh release create vX.Y.Z build/aiops-zotero-mcp-X.Y.Z.xpi`: `updates.json` points at that release asset.
- `main` has no branch rules (checked with `gh api repos/sachajw/aiops-zotero-mcp/rules/branches/main`), so commits go straight to `main` without a PR.
- `updates.json` (committed) is the plugin's `update_url` target, and the repo is public, so installed copies update themselves from it. Its `update_link` points at the release asset, so push the release commit and publish the GitHub release with the `.xpi` (`gh release create vX.Y.Z build/aiops-zotero-mcp-X.Y.Z.xpi`) together.
