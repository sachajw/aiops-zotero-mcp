## v0.10.0 (2026-11-22)

### Features

- set up the assistant with an API key in Settings; https providers and x-api-key keys

## v0.9.0 (2026-11-22)

### Docs

- CLAUDE.md covers the assistant and undo, with stale parts fixed

### Features

- choose the chat and actions model per backend

## v0.8.0 (2026-11-22)

### Features

- plugin changes can be undone with Zotero's Edit → Undo

## v0.7.0 (2026-11-22)

### Bug Fixes

- delete an item's saved conversation when the item is permanently deleted

### Features

- assistant keeps conversations across restarts, formats replies, and remembers changes when stopped

## v0.6.0 (2026-11-22)

### Docs

- CLAUDE.md: the uncaught exception on install is Zotero's L10n re-translation

### Features

- library assistant window: changes run only after you approve each one

## v0.5.0 (2026-11-22)

### Features

- chat about the open item in Zotero, with streaming, Stop and a settings pane

## v0.4.0 (2026-11-22)

### Features

- in-Zotero assistant: summarise to note, suggest tags, suggest collections

### Refactors

- run tools through a shared runner

## v0.3.0 (2026-11-22)

### Features

- find unfiled items, and collections by name with their full paths

## v0.2.4 (2026-11-22)

### Builds

- ship LICENSE inside the .xpi

### Chores

- license under MIT

### Docs

- repo is public, so Zotero's automatic updates work

### Security

- upgrade eslint and typescript-eslint so minimatch is patched (GHSA-g3hv-75wg-m249)

## v0.2.3 (2026-11-22)

### Bug Fixes

- strict tool inputs, paging fields, missing-file fulltext, failed metadata runs, half-applied renames
- overlapping add_file calls keep autoRecognizeFiles; stable search paging; batch writes in one transaction

### Docs

- README, CLAUDE.md and usage for strict inputs, paging fields, stable search order, all-or-nothing batch writes
- expand install, upgrade, and release docs

## v0.2.2 (2026-11-18)

### Bug Fixes

- load the bundle uncached so an upgrade never runs the previous version

### Chores

- track .gitattributes for graphify's graph.json merge driver

## v0.2.1 (2026-11-17)

### Bug Fixes

- zotero_retrieve_metadata reports slow items as pending instead of timing out

### Docs

- CLAUDE.md for agents; README covers pending results and the wait pref

## v0.2.0 (2026-11-17)

### Features

- zotero_retrieve_metadata runs Zotero's "Retrieve Metadata for PDF"

## v0.1.1 (2026-11-14)

### Builds

- cz bump updates updates.json and commits as 🚀 RELEASE

### Docs

- worked examples with real calls and replies; singular/plural in tool summaries
- usage guide for the whole Zotero library (connect, ask, dry run, tools, troubleshooting)

## v0.1.0 (2026-11-14)

### Builds

- zip the plugin with fflate instead of the system zip tool

### Features

- Zotero plugin serving MCP on Zotero's own localhost server
