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

- **Live tests** (`tests/live/`) need the plugin installed in a running Zotero and `ZOTERO_MCP_TOKEN` (from fnox), and optionally `ZOTERO_MCP_URL`. Without them they skip; they don't fail. They work in a throwaway collection and trash what they create. CI runs only the unit tests.
- **Trying a change in Zotero:** rebuild, then reinstall the `.xpi` (Tools → Plugins → Install Plugin From File, or the zotero-dev MCP `zotero_plugin_install`). Reinstalling replaces the running plugin; restart the MCP client connection afterwards if tools are missing.

## Architecture

Request path: `addon/bootstrap.js` → `src/index.ts` → `src/http/handler.ts` → `src/mcp/server.ts` → a tool in `src/tools/`.

- **Bootstrap/bundle:** `scripts/build.mjs` bundles `src/index.ts` with esbuild into an IIFE (`globalName: AiopsZoteroMcp`, target firefox128), which `bootstrap.js` loads with `loadSubScript` and calls `start()`/`stop()`. The build also stamps the version into `addon/manifest.json` (`__VERSION__`), writes `build/updates.json`, and zips with fflate using sorted paths and a fixed mtime, so builds are reproducible. Don't shell out to `zip`.
- **Endpoint registration (`src/index.ts`):** adds `Zotero.Server.Endpoints["/aiops-mcp"]` plus missing reason phrases (401/405/202), and removes both in `stop()`. The plugin opens no socket of its own.
- **Transport (`src/http/handler.ts`):** stateless, JSON-only MCP Streamable HTTP. Checks run in this order before the body is read: `Origin` present → 403 (DNS-rebinding guard); no token configured → 503; wrong token → 401 (constant-time compare). GET answers 405, so there's no server stream and no progress notifications.
- **MCP core (`src/mcp/`):** `protocol.ts` holds JSON-RPC types and protocol-version negotiation; `server.ts` handles `initialize`, `ping`, `tools/list` and `tools/call`. Tool input is validated with the tool's zod schema; `tools/list` publishes `z.toJSONSchema` output.
- **Tools (`src/tools/read.ts`, `write.ts`):** each one is a `defineTool({...})` (`src/mcp/tool.ts`). To add a tool, define it and append it to the `readTools`/`writeTools` array at the bottom of the file. Conventions:
  - Return `{ summary, data }`; the server serialises it as text (summary, then JSON).
  - Throw `ToolError` for anything the caller can fix: it becomes an `isError` result the model can act on. Other exceptions are also returned as errors but logged with `Zotero.logError`.
  - Write tools take `zDryRun` and return `dryRunResult(...)` before changing anything; take `zLibraryID` and resolve it with `libraryOf(id, { write: true })`.
  - Nothing deletes permanently: removal is trash only (`requireTrash`), and restore tools undo it. No tool runs arbitrary JS or changes Zotero settings, except that `zotero_add_file` switches off `autoRecognizeFiles` while adding and restores it afterwards.
  - Validate everything before the first mutation (e.g. `validateItemData` checks fields and creator types against Zotero's schema).
- **Zotero helpers (`src/zotero/library.ts`):** shared zod pieces (`zKey`, `zLibraryID`, `zDryRun`), lookups that throw `ToolError`, and the plain-object views (`itemSummary`, `itemDetail`, `attachmentView`, `collectionView`). Anything returned to a client goes through these views, never raw Zotero objects.
- **Zotero API types (`src/zotero/globals.d.ts`):** a hand-written, minimal declaration of the `Zotero` global covering only what the code uses. When calling a new Zotero API, add it here; check that it exists in the running Zotero first (e.g. with the zotero-dev MCP `zotero_execute_js`/`zotero_inspect_object`) rather than guessing.
- **Config is Zotero prefs** (defaults in `addon/prefs.js`), read at call time: `extensions.aiops-zotero-mcp.token` (bearer token) and `extensions.aiops-zotero-mcp.retrieveMetadataWaitSeconds` (how long `zotero_retrieve_metadata` waits before reporting unfinished items as `pending`; Zotero keeps processing them).
- **Unit tests** import `src/` directly with no `Zotero` global, so code that unit tests reach must not touch `Zotero` at module load or in default parameters. Put Zotero reads inside `run()` and test the pure part (see `parseWaitSeconds`).

## Commits and releases

- Commit messages follow `.cz.toml`: `<emoji> <LABEL>: <description>`, e.g. `🐛 FIX: ...`, `✨ FEATURE: ...`. The lefthook `commit-msg` hook and `.github/workflows/commitizen.yml` both enforce it. Pre-commit runs gitleaks, eslint and `tsc --noEmit`.
- Release with `cz bump`: it bumps `package.json` and `updates.json`, updates `CHANGELOG.md`, and commits as `🚀 RELEASE: vX.Y.Z` with tag `vX.Y.Z`. `manifest.json` gets the version at build time.
- `updates.json` (committed) is the plugin's `update_url` target. While the repo is private Zotero can't fetch it, so updates are installed by hand.
