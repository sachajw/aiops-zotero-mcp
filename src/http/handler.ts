import type { McpServer } from "../mcp/server.js";
import {
  JSONRPC_ERRORS,
  classifyMessage,
  errorResponse,
  isSupportedProtocolVersion,
} from "../mcp/protocol.js";

/** What the transport hands us: Zotero.Server lowercases header names. */
export interface HttpRequest {
  method: string;
  headers: Record<string, string | undefined>;
  /** Parsed JSON body (Zotero parses application/json before calling the endpoint). */
  body: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HandlerOptions {
  server: McpServer;
  /** Expected bearer token; empty or undefined means the plugin is not configured yet. */
  token: () => string | undefined;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(status: number, payload: unknown): HttpResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

function rejection(status: number, message: string, extra: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { ...JSON_HEADERS, ...extra },
    body: JSON.stringify(errorResponse(null, JSONRPC_ERRORS.INVALID_REQUEST, message)),
  };
}

/** Length-independent string comparison, so response time doesn't leak how much of a token matched. */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * MCP Streamable HTTP for a stateless, JSON-only server
 * (spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
 *
 * Order matters: origin and auth are checked before the body is looked at.
 */
export async function handleHttp(req: HttpRequest, options: HandlerOptions): Promise<HttpResponse> {
  // DNS-rebinding guard: the spec requires validating Origin. Agents don't send one; browsers do.
  if (req.headers.origin !== undefined) {
    return rejection(403, "Requests from browsers (with an Origin header) are not allowed");
  }

  const expected = options.token();
  if (!expected) {
    return rejection(503, "aiops-zotero-mcp has no token set. Set the extensions.aiops-zotero-mcp.token preference in Zotero.");
  }
  const auth = req.headers.authorization ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!presented || !constantTimeEqual(presented, expected)) {
    return rejection(401, "Missing or wrong bearer token", { "WWW-Authenticate": 'Bearer realm="aiops-zotero-mcp"' });
  }

  if (req.method !== "POST") {
    // No server-to-client SSE stream: GET gets 405 as the spec allows.
    return { status: 405, headers: { Allow: "POST" }, body: "" };
  }

  const headerVersion = req.headers["mcp-protocol-version"];
  if (headerVersion !== undefined && !isSupportedProtocolVersion(headerVersion)) {
    return rejection(400, `Unsupported MCP-Protocol-Version: ${headerVersion}`);
  }

  const incoming = classifyMessage(req.body);
  switch (incoming.kind) {
    case "invalid":
      return json(400, incoming.error);
    case "response":
      // We never send requests to the client, so a response is unexpected but harmless.
      return { status: 202, headers: {}, body: "" };
    case "notification":
      options.server.handleNotification(incoming.message);
      return { status: 202, headers: {}, body: "" };
    case "request":
      return json(200, await options.server.handleRequest(incoming.message));
  }
}
