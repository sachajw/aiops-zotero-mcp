/**
 * JSON-RPC 2.0 and MCP protocol types and constants.
 * Spec: https://modelcontextprotocol.io/specification/2025-11-25
 */

/** Newest first. The first entry is offered when the client asks for one we don't know. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

/** Assumed when a client sends no MCP-Protocol-Version header (spec: basic/transports). */
export const DEFAULT_HEADER_PROTOCOL_VERSION: ProtocolVersion = "2025-03-26";

export function isSupportedProtocolVersion(v: unknown): v is ProtocolVersion {
  return typeof v === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(v);
}

/** Version negotiation (spec: basic/lifecycle): echo a supported request, else offer our newest. */
export function negotiateProtocolVersion(requested: unknown): ProtocolVersion {
  return isSupportedProtocolVersion(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
}

export const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: Record<string, unknown>;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export type IncomingMessage =
  | { kind: "request"; message: JsonRpcRequest }
  | { kind: "notification"; message: JsonRpcNotification }
  | { kind: "response" }
  | { kind: "invalid"; error: JsonRpcError };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Classify one parsed JSON-RPC message. Batches are not part of MCP 2025-06-18+ and are rejected. */
export function classifyMessage(body: unknown): IncomingMessage {
  const invalid = (message: string, id: JsonRpcId | null = null): IncomingMessage => ({
    kind: "invalid",
    error: errorResponse(id, JSONRPC_ERRORS.INVALID_REQUEST, message),
  });

  if (!isObject(body)) {
    return invalid("Expected one JSON-RPC message object (batches are not supported)");
  }
  if (body.jsonrpc !== "2.0") {
    return invalid('Missing or wrong "jsonrpc" (must be "2.0")');
  }
  const hasId = "id" in body;
  const id = body.id;
  if (hasId && !(typeof id === "string" || typeof id === "number")) {
    return invalid('"id" must be a string or number');
  }
  if ("result" in body || "error" in body) {
    return { kind: "response" };
  }
  if (typeof body.method !== "string" || body.method === "") {
    return invalid('Missing "method"', hasId ? (id as JsonRpcId) : null);
  }
  if (body.params !== undefined && !isObject(body.params)) {
    return invalid('"params" must be an object', hasId ? (id as JsonRpcId) : null);
  }
  const base = {
    jsonrpc: "2.0" as const,
    method: body.method,
    ...(body.params !== undefined ? { params: body.params as Record<string, unknown> } : {}),
  };
  return hasId
    ? { kind: "request", message: { ...base, id: id as JsonRpcId } }
    : { kind: "notification", message: base };
}

export function successResponse(id: JsonRpcId, result: Record<string, unknown>): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
