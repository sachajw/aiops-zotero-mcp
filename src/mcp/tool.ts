import { z } from "zod";

/** MCP tool annotations (spec: server/tools). Hints for clients, not guarantees. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** What a tool returns: a value that is serialised as JSON text for the client. */
export interface ToolOutput {
  /** Short human summary shown first, e.g. "Found 3 items". */
  summary: string;
  /** Machine-readable payload. */
  data?: unknown;
}

/**
 * Error a tool throws for a problem the caller can fix (unknown key, bad path...).
 * Reported as a tool result with isError so the model can correct itself, as the spec asks.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  run: (args: z.infer<S>) => Promise<ToolOutput>;
}

/** Keeps the input type tied to the schema at the definition site. */
export function defineTool<S extends z.ZodObject>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

/** JSON Schema for tools/list. Zod 4 emits draft 2020-12, the MCP default dialect. */
export function inputJsonSchema(tool: ToolDefinition): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
