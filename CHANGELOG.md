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
