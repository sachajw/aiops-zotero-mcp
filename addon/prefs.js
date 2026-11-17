// Bearer token every MCP request must carry. Empty = endpoint refuses all requests (503).
pref("extensions.aiops-zotero-mcp.token", "");
// Seconds zotero_retrieve_metadata waits before reporting unfinished attachments as pending
// (they keep running in Zotero). Keep it under your MCP client's tool timeout.
pref("extensions.aiops-zotero-mcp.retrieveMetadataWaitSeconds", 45);
