# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A Zotero plugin (bootstrapped; Zotero 7.0–10.x, tested on 10.0.9) with two parts:

1. **An MCP server** on Zotero's own HTTP server at `http://127.0.0.1:23119/aiops-mcp`, exposing typed tools over Zotero's JavaScript API.
2. **An in-Zotero assistant**: an Assistant section in the item pane (item chat, summarise / suggest tags / suggest collection) and a Library assistant window that can change the library after the user approves each change. It talks to any model through the Anthropic Messages or OpenAI chat-completions API: providers added in Settings with an API key (Anthropic, OpenAI, OpenRouter, Z.ai), local servers (Ollama, LM Studio), gateways, or Claude-Code-style settings files.

Both use the same tools. User-facing docs: `README.md` and `docs/usage.md` (tool reference, troubleshooting, and connecting clients, including the Claude desktop app through the `mcp-remote` stdio bridge for subscription-only users; that config was tested by running the bridge exactly as written, so re-test it if the endpoint or auth changes). Zotero's plugin API changes per release are documented under "Zotero N for Developers" at https://www.zotero.org/support/dev.

## Commands

Tools are pinned in `mise.toml` (node 22, npm 11, lefthook, commitizen, gitleaks). npm 11 is required: npm 10.9 crashes resolving vitest 4.1's optional peers.

```bash
mise install && mise run install    # toolchain, then npm ci (first build fails on missing esbuild without this)
mise run check                      # typecheck + lint + unit tests + build: what CI runs
mise run build                      # build/aiops-zotero-mcp-<version>.xpi (version from package.json)
npx vitest run tests/unit/agent.test.ts          # one unit test file
npx vitest run tests/unit -t "constantTimeEqual" # tests matching a name
fnox exec -P shell -- mise run test:live         # live tests (see below)
```

- **Live tests** (`tests/live/`) skip rather than fail when their inputs are missing, so check the summary says `passed`, not `skipped`. CI runs only the unit tests.
  - `library.test.ts`: every MCP tool against the running Zotero. Needs the plugin installed and `ZOTERO_MCP_TOKEN` (from fnox), optionally `ZOTERO_MCP_URL`. Works in a throwaway collection and trashes what it creates.
  - `assistant.test.ts`: prompts, streaming, tool round trips and the approval gate against real model proxies, with real tool schemas and fake tool runs (no Zotero needed). Needs `AIOPS_LLM_PROFILE_FILES` (comma-separated settings-file paths) and/or an OpenAI-format server (`AIOPS_LLM_OPENAI_URL`, `AIOPS_LLM_OPENAI_MODEL`, optional `AIOPS_LLM_OPENAI_KEY` and `AIOPS_LLM_OPENAI_TOKEN_PARAM`); `AIOPS_LLM_MODEL` picks the tier for settings files (`haiku` default, `sonnet`, `default`, or a model ID). The fake tools answer like the real ones (search returns items, only `zotero_get_fulltext` returns text); keep it that way, or models chase odd results and the tests flake.
- **Trying a change in Zotero:** rebuild, then reinstall the `.xpi` (Tools → Plugins → Install Plugin From File, or the zotero-dev MCP `zotero_plugin_install`). Reinstalling replaces the running plugin; restart the MCP client afterwards if tools are missing (Claude Code reads the tool list only at startup). To confirm which build is running, compare `shasum` of `~/Library/Application Support/Zotero/Profiles/*/extensions/aiops-zotero-mcp@sachajw.github.io.xpi` with the one in `build/`; a rebuild with the same version may not replace the installed file, so remove the plugin first or bump the version.
- Before calling a Zotero API you haven't used, check it exists in the running Zotero (zotero-dev MCP `zotero_execute_js` / `zotero_inspect_object`; Zotero's own source is readable there with `fetch("chrome://zotero/content/...")`), then declare it in `src/zotero/globals.d.ts`.
- When testing Edit → Undo in a real Zotero, undo once, right after the change, and only after `Zotero.UndoHistory.getUndoAction()` shows the expected label: the undo stack is global and also holds the user's own actions.
- `typecheck` covers `src/` only (`tsconfig.json` include); tests are type-checked by vitest, not tsc.
- "uncaught exception: undefined" in Zotero's error console on every install, enable or disable is Zotero's, not ours: shipping `locale/` makes Zotero update the shared plugin L10n source, Firefox re-translates every window, and four of Zotero's main-window buttons (`browser-window-{minimize,maximize,restore-down,close}-button`, strings in an unshipped `browser/menubar.ftl`) fail. Reproduce with `document.l10n.translateRoots()` on the main window.

## Architecture

**Loading:** `scripts/build.mjs` bundles `src/index.ts` with esbuild into an IIFE (`globalName: AiopsZoteroMcp`, target firefox128). `addon/bootstrap.js` registers a `chrome://aiops-zotero-mcp/content/` package for the plugin's `content/` folder (Zotero won't load a `jar:` URL as a window), loads the bundle with `loadSubScriptWithOptions({ ignoreCache: true })` (the startup cache would otherwise serve the previous version's bundle after an upgrade), calls `start()` / `stop()`, and forwards `onMainWindowLoad/Unload`. The build stamps the version into `addon/manifest.json` (`__VERSION__`), copies `addon/static/` to `content/` and `addon/locale/` to `locale/` (Fluent files there are registered automatically), writes `build/updates.json`, and zips with fflate using sorted paths and a fixed mtime so builds are reproducible. Don't shell out to `zip`.

**`start()` (`src/index.ts`):** registers `Zotero.Server.Endpoints["/aiops-mcp"]` plus missing reason phrases (401/405/202), then `registerAssistant` (`src/ui/assistant.ts`: item-pane section, menus, settings pane, deletion observer). `stop()` undoes all of it. The plugin opens no socket of its own; an assistant registration failure doesn't take the MCP endpoint down.

### MCP server

Request path: `src/http/handler.ts` → `src/mcp/server.ts` → `src/mcp/runner.ts` → a tool in `src/tools/`.

- **Transport (`handler.ts`):** stateless, JSON-only MCP Streamable HTTP. Checks run in this order before the body is read: `Origin` present → 403 (DNS-rebinding guard); no token configured → 503; wrong token → 401 (constant-time compare). GET answers 405: no server stream, no progress notifications.
- **MCP core:** `protocol.ts` has JSON-RPC types and protocol-version negotiation; `server.ts` handles `initialize`, `ping`, `tools/list` (publishes `z.toJSONSchema`) and `tools/call`. `runner.ts` (`runTool`, `formatOutput`) validates input with the tool's zod schema, runs it and formats the result; the assistant calls tools through the same function, so both see identical validation, errors and output.

### Tools (`src/tools/read.ts`, `write.ts`)

Each tool is a `defineTool({...})` (`src/mcp/tool.ts`); add one by defining it and appending it to `readTools` / `writeTools` at the bottom of the file. A new tool also needs a row in the README tools table, an entry in `docs/usage.md` §5, and coverage in `tests/live/library.test.ts`.

- Return `{ summary, data }`; the text is the summary, a blank line, then pretty JSON. The live tests split on that first blank line, so keep summaries to one paragraph. Paged tools add `hasMore` / `nextOffset` with `nextPage` (`library.ts`).
- `defineTool` makes every input strict: unknown keys are a validation error and `tools/list` publishes `additionalProperties: false`. Don't bypass it with `.passthrough()` / `.loose()`.
- Throw `ToolError` for anything the caller can fix: it becomes an `isError` result. Other exceptions are returned as errors too but also logged with `Zotero.logError`.
- Write tools take `zDryRun` and return `dryRunResult(...)` before changing anything, and resolve `zLibraryID` with `libraryOf(id, { write: true })`. Validate everything before the first mutation (e.g. `validateItemData` checks fields and creator types against Zotero's schema).
- Nothing deletes permanently: removal is trash only (`requireTrash`), undone by the restore tools. No tool runs arbitrary JS or changes Zotero settings, except that `zotero_add_file` switches off `autoRecognizeFiles` while adding.
- **Undo:** changes to existing objects go through `undoable(label, fn)` (`write.ts`): one transaction that calls `Zotero.UndoHistory.stageAction` with one of Zotero's own `undo-action-*` IDs, so Edit → Undo reverses it as one step. Save with `save()` inside it, never `saveTx()`. `saveAllOrNone` does this for batches, so a failure rolls back every item. Creation isn't undoable in Zotero (create tools don't use it), and `Zotero.Items.trashTx` labels its own step.
- **Concurrency:** clients call tools in parallel. Anything that temporarily changes shared state (a pref) goes through `suspender` (`src/zotero/suspend.ts`), which saves on the first entry and restores on the last exit; a plain save / `finally`-restore loses the user's value when calls overlap.
- **Zotero quirks:** `Zotero.Search.search()` has no `ORDER BY`, so sort IDs before `offset` / `limit`. `attachmentText` throws for a PDF whose file is missing, so check `getFilePathAsync()` + `IOUtils.exists` first. If a tool makes two separate changes (file rename, then title save), a failure after the first must say what already changed.
- **Helpers (`src/zotero/library.ts`):** shared zod pieces (`zKey`, `zLibraryID`, `zDryRun`), lookups that throw `ToolError`, and the plain-object views (`itemSummary`, `itemDetail`, `attachmentView`, `collectionView` with its full `path`). Anything returned goes through these views, never raw Zotero objects.

### Assistant (`src/assistant/`, `src/ui/`)

`src/assistant/` is pure (tested without Zotero) except `zotero.ts`; `src/ui/` touches Zotero and isn't unit-tested.

- **Backends (`config.ts`, `transport.ts`):** two kinds, listed together by `backendLabels` (files first). Settings files: `llm.profileFiles` lists Claude-Code-style files (`env.ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` → `x-api-key`, `ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`, `ANTHROPIC_*_MODEL`), read on every request. Providers added in Settings: `llm.backends` holds name / URL / key type / models (`validateStoredBackend`, presets in `PROVIDERS`); the key is in Firefox's login manager (`keyStore` in `zotero.ts`, origin `chrome://aiops-zotero-mcp`, realm = name), never in prefs. Zotero 11 replaces `removeLogin` with `removeLoginAsync`; `keyStore.remove` uses whichever exists. Two API formats: Anthropic Messages (default) and OpenAI chat completions (`format: "openai"`, `tokenParam` `max_completion_tokens` | `max_tokens`); `openai.ts` translates requests out and whole or streamed replies back into the Anthropic shape the agent works in, so nothing else changes per format. Ollama ignores forced `tool_choice`; the actions' JSON-text fallback covers it. `assertBaseURL`: https anywhere, plain http only to loopback, so a key never crosses a network unencrypted. A provider on loopback may have no key (a gateway that signs in itself); anywhere else a key is required (`backendFromStored`, `saveBackend`). Models are chosen by tier (`default`, `opus`, `sonnet`, `haiku`, mapped through each settings file, or a literal model ID): `modelChoice` takes the backend's own `llm.chatModel.<label>` / `llm.actionModel.<label>` first, then the shared `llm.chatModel` / `llm.actionModel`, then `sonnet` / `haiku`. The settings pane builds those per-backend rows in `preferences.js`. `transport.ts` posts to `/v1/messages`, streaming through `sse.ts` when given `onText`. fetch and AbortController are injected: the plugin sandbox has `fetch` but no `AbortController`, so Zotero passes the main window's.
- **Agent loop (`agent.ts`):** sequential tool calls, results capped and returned in order, `tool_choice: none` on the last allowed round so the model must answer. Write tools are gated: dry run, `approve(preview)`, then the real call with the frozen previewed args. On Stop it keeps whatever already ran (`kept: true`, turn closed with "(Stopped by the user.)") so an approved change stays in the history; a turn where nothing ran is dropped.
- **Toolsets (`toolset.ts`):** the item chat gets read tools only; the library assistant gets read and write tools. `zotero_add_file` and `zotero_retrieve_metadata` are never offered to a model.
- **History:** keep `thinking` / `redacted_thinking` blocks (with signature) unchanged, or Claude replies empty on the next turn after tool use; strip them when the backend changes (they're signed by the backend that wrote them). `ui/chat.ts` does both.
- **Actions (`actions.ts`):** prompts, plus parsing proposals from the forced `propose_*` tool or the same JSON as reply text (some GLM models ignore forced `tool_choice`). Reasoning models need the full `maxTokens`, since thinking counts against it. Proposals are filtered against what exists (tags by spelling, collections by key). The model never writes here: `ui/assistant.ts` applies what the user ticks through `runTool` on the write tools.
- **UI:** `ui/assistant.ts` registers the item-pane section (also shown in the reader's side pane; `onRender` runs with `item` undefined when nothing is selected), the item / Tools / collection menus and the settings pane (`addon/static/preferences.{xhtml,js}`; built by `preferences.js` on `Zotero.AiopsZoteroMcp` = `{ listBackends, saveBackend, removeBackend, testConnection, providers }`, set while the plugin runs). `ui/window.ts` opens the library assistant (`chrome://aiops-zotero-mcp/content/assistant.xhtml`); attach its unload listener only after load, because the initial about:blank page fires unload too. `ui/chat.ts` renders chats and the approval card; Stop or closing the window refuses a pending change.
- **Rendering:** build DOM with `createElementNS` + `textContent` only (`ui/dom.ts`, `ui/markdown.ts` over the pure `assistant/markdown.ts`); these are privileged windows, so model and document text must never be parsed as HTML. Links open via `Zotero.launchURL`, http(s) only.
- **Persistence (`store.ts`):** each conversation is saved after every turn as validated JSON in `<Zotero data dir>/aiops-zotero-mcp/chats/`, keyed `item:<libraryID>:<itemKey>` or `library`; `storeFileName` refuses any other key, so no path can escape that folder. New chat or permanently deleting the item (a Notifier observer) removes the file; trashing keeps it.
- **Zotero UI APIs** (`ItemPaneManager`, `MenuManager`, `PreferencePanes`, `Notifier`, `UndoHistory`) are typed in `globals.d.ts`. Fluent IDs live in `addon/locale/en-US/aiops-zotero-mcp.ftl` and are prefixed `aiops-`.

### Config and tests

- **Config is Zotero prefs** (defaults and comments in `addon/prefs.js`), read at call time: `extensions.aiops-zotero-mcp.token` (bearer token), `…retrieveMetadataWaitSeconds` (how long `zotero_retrieve_metadata` waits before reporting unfinished items as `pending`; if the run itself throws they're `failed`, see `unfinishedOutcome`), and the assistant's `…llm.*` prefs.
- **Unit tests** import `src/` directly with no `Zotero` global, so code they reach must not touch `Zotero` at module load or in default parameters. Put Zotero reads inside `run()` and test the pure part (see `parseWaitSeconds`), or inject them (see `suspender`, `runAgent`, `send`).

## Commits and releases

- Commit messages follow `.cz.toml`: `<emoji> <LABEL>: <description>`, e.g. `🐛 FIX: ...`, `✨ FEATURE: ...`. The lefthook `commit-msg` hook and `.github/workflows/commitizen.yml` enforce it; pre-commit runs gitleaks, eslint and `tsc --noEmit`. `main` has no branch rules, so commits go straight to `main`.
- Release with `cz bump` (bumps `package.json` and `updates.json`, updates `CHANGELOG.md`, commits `🚀 RELEASE: vX.Y.Z`, tags `vX.Y.Z`; only FEATURE / FIX / RELEASE commits trigger a bump, so pass `--increment PATCH` otherwise), then `mise run build`, push the commit and tag, and `gh release create vX.Y.Z build/aiops-zotero-mcp-X.Y.Z.xpi`. Do the push and the release together: the repo is public and installed copies update themselves from `updates.json` on `main`, whose `update_link` is that release asset.
