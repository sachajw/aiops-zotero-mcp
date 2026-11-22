/**
 * The parts of the Anthropic Messages API the assistant uses (POST /v1/messages), as spoken by any
 * local proxy that accepts that format (Claude, or Z.ai's GLM behind an Anthropic-format proxy).
 * Pure: no Zotero, no network.
 */
import { z } from "zod";
import { type ToolDefinition, inputJsonSchema } from "../mcp/tool.js";

export interface TextBlock { type: "text"; text: string }
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
export interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface MessageParam {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolParam {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface MessagesRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: MessageParam[];
  tools?: ToolParam[];
  tool_choice?: { type: "auto" } | { type: "any" } | { type: "tool"; name: string };
  stream?: boolean;
}

/** A response block we know how to use; other block types (thinking, server tools) are dropped. */
const zBlock = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
]);

export const zMessage = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  role: z.literal("assistant"),
  content: z.array(z.unknown()),
  stop_reason: z.string().nullable().optional(),
});

export interface Message {
  model?: string;
  content: Array<TextBlock | ToolUseBlock>;
  stop_reason: string | null;
}

/** Validate a response body, keeping only the block types the assistant handles. */
export function parseMessage(body: unknown): Message {
  const m = zMessage.parse(body);
  const content = m.content.flatMap((b) => {
    const parsed = zBlock.safeParse(b);
    return parsed.success ? [parsed.data as TextBlock | ToolUseBlock] : [];
  });
  return { model: m.model, content, stop_reason: m.stop_reason ?? null };
}

/** The error message inside an error response body, if there is one. */
export function errorMessage(body: unknown): string | undefined {
  const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
  return parsed.success ? parsed.data.error.message : undefined;
}

export function textOf(message: Message): string {
  return message.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("").trim();
}

export function toolUsesOf(message: Message): ToolUseBlock[] {
  return message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

/** One of the plugin's tools, offered to the model. */
export function toolParam(tool: ToolDefinition): ToolParam {
  return { name: tool.name, description: tool.description, input_schema: inputJsonSchema(tool) };
}
