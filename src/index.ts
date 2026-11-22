/**
 * Plugin entry. bootstrap.js loads the bundle and calls start()/stop().
 * The MCP endpoint lives on Zotero's own HTTP server (127.0.0.1, port from Zotero's
 * httpServer.port pref, 23119 by default), so the plugin opens no socket of its own.
 */
import { handleHttp } from "./http/handler.js";
import { McpServer } from "./mcp/server.js";
import { addStrings, registerAssistant, removeStrings, unregisterAssistant } from "./ui/assistant.js";
import { readTools } from "./tools/read.js";
import { writeTools } from "./tools/write.js";

export const ENDPOINT_PATH = "/aiops-mcp";
export const TOKEN_PREF = "extensions.aiops-zotero-mcp.token";

let registered = false;

/**
 * Status codes this endpoint returns that Zotero.Server.responseCodes lacks (checked on Zotero 10.0.9);
 * without them the status line reads e.g. "HTTP/1.0 401 undefined". Added while loaded, removed on stop.
 */
const REASON_PHRASES: Record<number, string> = { 202: "Accepted", 401: "Unauthorized", 405: "Method Not Allowed" };
const addedPhrases: number[] = [];

export function start({ id, version, rootURI }: { id: string; version: string; rootURI: string }): void {
  const server = new McpServer({
    info: {
      name: "aiops-zotero-mcp",
      title: "Zotero",
      version,
      instructions:
        "Tools for the user's Zotero library. Items, collections and attachments are addressed by 8-character keys " +
        "(zotero_search_items / zotero_list_collections find them). Every change accepts dry_run: true to preview. " +
        "Nothing here deletes permanently: zotero_trash_items is undone by zotero_restore_items.",
    },
    tools: [...readTools, ...writeTools],
    ready: () => Zotero.initializationPromise,
    logError: (e) => Zotero.logError(e),
  });

  class McpEndpoint {
    supportedMethods = ["GET", "POST"];
    supportedDataTypes = ["application/json"];
    async init(request: ZoteroAPI.ServerRequestData): Promise<ZoteroAPI.ServerResponse> {
      const res = await handleHttp(
        { method: request.method, headers: request.headers, body: request.data },
        { server, token: () => String(Zotero.Prefs.get(TOKEN_PREF, true) ?? "") },
      );
      return [res.status, res.headers, res.body];
    }
  }

  for (const [code, phrase] of Object.entries(REASON_PHRASES)) {
    if (Zotero.Server.responseCodes[Number(code)] === undefined) {
      Zotero.Server.responseCodes[Number(code)] = phrase;
      addedPhrases.push(Number(code));
    }
  }
  Zotero.Server.Endpoints[ENDPOINT_PATH] = McpEndpoint;
  registered = true;
  Zotero.debug(`aiops-zotero-mcp ${version}: MCP endpoint at ${ENDPOINT_PATH}`);
  try {
    registerAssistant(id, rootURI);
  } catch (e) {
    // The MCP endpoint keeps working even if the assistant UI can't register.
    Zotero.logError(e);
  }
}

/** bootstrap.js forwards Zotero's main-window hooks, so windows opened later get the strings too. */
export function onMainWindowLoad(window: Window & { MozXULElement: { insertFTLIfNeeded(file: string): void } }): void {
  addStrings(window);
}

export function onMainWindowUnload(window: Window): void {
  removeStrings(window);
}

export function stop(): void {
  unregisterAssistant();
  if (registered) {
    Reflect.deleteProperty(Zotero.Server.Endpoints, ENDPOINT_PATH);
    for (const code of addedPhrases.splice(0)) Reflect.deleteProperty(Zotero.Server.responseCodes, code);
    registered = false;
  }
}
