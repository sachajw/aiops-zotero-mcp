import {
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  JSONRPC_ERRORS,
  errorResponse,
  negotiateProtocolVersion,
  successResponse,
} from "./protocol.js";
import { runTool } from "./runner.js";
import { type ToolDefinition, inputJsonSchema } from "./tool.js";

export interface ServerInfo {
  name: string;
  title: string;
  version: string;
  instructions?: string;
}

export interface McpServerOptions {
  info: ServerInfo;
  tools: ToolDefinition[];
  /** Awaited before any tool runs, e.g. Zotero.initializationPromise. */
  ready?: () => Promise<void>;
  /** Where unexpected tool failures are logged (they are reported to the client too). */
  logError?: (error: unknown) => void;
}

/**
 * Stateless MCP request handler: one JSON-RPC message in, at most one response out.
 * Transport concerns (HTTP, auth, origin) live in http/handler.ts.
 */
export class McpServer {
  private readonly tools: Map<string, ToolDefinition>;

  constructor(private readonly options: McpServerOptions) {
    this.tools = new Map(options.tools.map((t) => [t.name, t]));
    if (this.tools.size !== options.tools.length) {
      throw new Error("Duplicate tool names");
    }
  }

  /** Notifications need no response; MCP's (initialized, cancelled...) need no action here. */
  handleNotification(_message: JsonRpcNotification): void {}

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    switch (request.method) {
      case "initialize":
        return successResponse(request.id, this.initialize(request.params));
      case "ping":
        return successResponse(request.id, {});
      case "tools/list":
        return successResponse(request.id, {
          tools: [...this.tools.values()].map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: inputJsonSchema(t),
            annotations: { title: t.title, ...t.annotations },
          })),
        });
      case "tools/call":
        return this.callTool(request);
      default:
        return errorResponse(request.id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${request.method}`);
    }
  }

  private initialize(params: Record<string, unknown> | undefined): Record<string, unknown> {
    const { info } = this.options;
    return {
      protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: info.name, title: info.title, version: info.version },
      ...(info.instructions ? { instructions: info.instructions } : {}),
    };
  }

  private async callTool(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const run = await runTool(this.tools, request.params?.name, request.params?.arguments, this.options);
    if (run.kind === "unknown") {
      return errorResponse(request.id, JSONRPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${run.name}`);
    }
    return successResponse(request.id, run.isError ? toolError(run.text) : { content: [{ type: "text", text: run.text }], isError: false });
  }
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
}
