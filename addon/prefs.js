// Bearer token every MCP request must carry. Empty = endpoint refuses all requests (503).
pref("extensions.aiops-zotero-mcp.token", "");
// Seconds zotero_retrieve_metadata waits before reporting unfinished attachments as pending
// (they keep running in Zotero). Keep it under your MCP client's tool timeout.
pref("extensions.aiops-zotero-mcp.retrieveMetadataWaitSeconds", 45);

// Assistant (Claude, Z.ai or any local proxy that speaks the Anthropic Messages API).
// Absolute paths to Claude-Code-style settings files (env.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,
// ANTHROPIC_*_MODEL), one per line. The file is read on every request; the plugin stores no token.
// The base URL must be a local proxy (127.0.0.1, localhost or [::1]).
pref("extensions.aiops-zotero-mcp.llm.profileFiles", "");
// Which of those files to use, by name without .settings.json (e.g. "zai"); empty = the first.
pref("extensions.aiops-zotero-mcp.llm.activeProfile", "");
// Model for one-click actions: default, opus, sonnet or haiku (from the settings file), or a model ID.
pref("extensions.aiops-zotero-mcp.llm.actionModel", "sonnet");
// Model for the chats (same choices).
pref("extensions.aiops-zotero-mcp.llm.chatModel", "sonnet");
// Per backend, add extensions.aiops-zotero-mcp.llm.chatModel.<name> / .actionModel.<name>
// (<name> = settings file name without .settings.json, e.g. chatModel.zai = default); it wins
// over the shared setting for that backend only. Settings → Zotero MCP Assistant has a row for each.
// Most tool calls the chat may make before it has to answer, and the most characters of one tool result it sees.
pref("extensions.aiops-zotero-mcp.llm.maxToolIterations", 10);
pref("extensions.aiops-zotero-mcp.llm.maxToolResultChars", 20000);
pref("extensions.aiops-zotero-mcp.llm.maxTokens", 4096);
// Characters of full text sent with an item (max 100000).
pref("extensions.aiops-zotero-mcp.llm.contextChars", 60000);
pref("extensions.aiops-zotero-mcp.llm.requestTimeoutSeconds", 120);
