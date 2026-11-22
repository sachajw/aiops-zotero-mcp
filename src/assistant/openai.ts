/**
 * The OpenAI chat-completions format (POST <base>/chat/completions), spoken by OpenAI, OpenRouter,
 * Ollama, LM Studio and many gateways. The assistant works in the Anthropic message shape
 * (anthropic.ts); this translates requests out and replies (whole or streamed) back. Pure.
 */
import { ToolError } from "../mcp/tool.js";
import type { ContentBlock, Message, MessageParam, MessagesRequest, ReplyBlock } from "./anthropic.js";

/** Which field carries the reply cap: OpenAI's current name, or the older one most compatible servers use. */
export type TokenParam = "max_completion_tokens" | "max_tokens";

interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type OAIMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

function textOfBlocks(blocks: ContentBlock[]): string {
  return blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

/** One Anthropic-shaped message as OpenAI messages (a user turn of tool results becomes tool messages). */
function convertMessage(m: MessageParam): OAIMessage[] {
  if (typeof m.content === "string") return [{ role: m.role, content: m.content }];
  if (m.role === "assistant") {
    const calls = m.content.flatMap((b): OAIToolCall[] =>
      b.type === "tool_use" ? [{ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }] : [],
    );
    const text = textOfBlocks(m.content); // thinking blocks have no OpenAI equivalent and are dropped
    return [{ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }];
  }
  const out: OAIMessage[] = m.content.flatMap((b): OAIMessage[] =>
    b.type === "tool_result" ? [{ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${b.content}` : b.content }] : [],
  );
  const text = textOfBlocks(m.content);
  if (text) out.push({ role: "user", content: text });
  return out;
}

export function toOpenAIRequest(req: MessagesRequest, tokenParam: TokenParam, stream: boolean): Record<string, unknown> {
  const messages: OAIMessage[] = [
    ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
    ...req.messages.flatMap(convertMessage),
  ];
  const choice = req.tool_choice;
  return {
    model: req.model,
    [tokenParam]: req.max_tokens,
    messages,
    ...(req.tools?.length
      ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })) }
      : {}),
    ...(choice
      ? {
          tool_choice:
            choice.type === "tool" ? { type: "function", function: { name: choice.name } } : choice.type === "any" ? "required" : choice.type,
        }
      : {}),
    stream,
  };
}

const STOP: Record<string, string> = { tool_calls: "tool_use", function_call: "tool_use", stop: "end_turn", length: "max_tokens", content_filter: "refusal" };

function toolUse(id: string, name: string, args: string): ReplyBlock {
  let input: unknown;
  try {
    input = args.trim() ? JSON.parse(args) : {};
  } catch {
    input = {}; // malformed arguments: the tool's own validation reports what's missing
  }
  return { type: "tool_use", id, name, input: input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {} };
}

/** A whole (non-streamed) chat-completions reply as a Message. */
export function fromOpenAIResponse(body: unknown): Message {
  const b = body as { model?: string; choices?: Array<{ finish_reason?: string; message?: { content?: unknown; tool_calls?: OAIToolCall[] } }> };
  const choice = b?.choices?.[0];
  if (!choice?.message) throw new ToolError("The reply isn't a chat-completions response");
  const content: ReplyBlock[] = [];
  if (typeof choice.message.content === "string" && choice.message.content) content.push({ type: "text", text: choice.message.content });
  for (const call of choice.message.tool_calls ?? []) content.push(toolUse(call.id, call.function?.name ?? "", call.function?.arguments ?? ""));
  return { model: b.model, content, stop_reason: STOP[choice.finish_reason ?? ""] ?? choice.finish_reason ?? null };
}

/** Builds a Message from a streamed chat-completions reply (data: lines, ending with [DONE]). */
export class OpenAIStreamAccumulator {
  private buffer = "";
  private text = "";
  private calls = new Map<number, { id: string; name: string; args: string }>();
  private model: string | undefined;
  private finish: string | null = null;
  private done = false;

  constructor(private readonly onText: (delta: string) => void = () => {}) {}

  push(chunk: string): void {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        this.done = true;
        continue;
      }
      let event: { model?: string; error?: { message?: string }; choices?: Array<{ finish_reason?: string | null; delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.error) throw new ToolError(`The model stopped with an error: ${event.error.message ?? "unknown error"}`);
      this.model ??= event.model;
      const choice = event.choices?.[0];
      if (!choice) continue;
      if (choice.delta?.content) {
        this.text += choice.delta.content;
        this.onText(choice.delta.content);
      }
      for (const call of choice.delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = this.calls.get(index) ?? { id: "", name: "", args: "" };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.args += call.function.arguments;
        this.calls.set(index, current);
      }
      if (choice.finish_reason) this.finish = choice.finish_reason;
    }
  }

  message(): Message {
    if (!this.done && !this.finish) throw new ToolError("The reply stream ended early");
    const content: ReplyBlock[] = this.text ? [{ type: "text", text: this.text }] : [];
    for (const [i, call] of [...this.calls].sort(([a], [b]) => a - b)) content.push(toolUse(call.id || `call_${i}`, call.name, call.args));
    return { model: this.model, content, stop_reason: STOP[this.finish ?? ""] ?? this.finish };
  }
}
