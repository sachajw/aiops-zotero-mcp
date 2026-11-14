import { z } from "zod";
import {
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  JSONRPC_ERRORS,
  errorResponse,
  negotiateProtocolVersion,
  successResponse,
} from "./protocol.js";
import { type ToolDefinition, ToolError, inputJsonSchema } from "./tool.js";

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
    const name = request.params?.name;
    const tool = typeof name === "string" ? this.tools.get(name) : undefined;
    if (!tool) {
      return errorResponse(request.id, JSONRPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${String(name)}`);
    }

    const parsed = tool.input.safeParse(request.params?.arguments ?? {});
    if (!parsed.success) {
      return successResponse(request.id, toolError(`Invalid arguments for ${tool.name}:\n${z.prettifyError(parsed.error)}`));
    }

    try {
      await this.options.ready?.();
      const output = await tool.run(parsed.data);
      const text = output.data === undefined
        ? output.summary
        : `${output.summary}\n\n${JSON.stringify(output.data, null, 2)}`;
      return successResponse(request.id, { content: [{ type: "text", text }], isError: false });
    } catch (error) {
      if (!(error instanceof ToolError)) {
        this.options.logError?.(error);
      }
      const message = error instanceof Error ? error.message : String(error);
      return successResponse(request.id, toolError(message));
    }
  }
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
}
