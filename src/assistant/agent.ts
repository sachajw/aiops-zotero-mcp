/**
 * The chat loop: send the conversation, run any tools the model asks for, send the results back,
 * until it answers in text. Pure: the model call and the tool runner are injected.
 *
 * Writes are gated: a write tool first runs as a dry run, the user sees that preview, and only on
 * approval does the same call run for real with exactly the arguments that were previewed.
 */
import type { ContentBlock, Message, MessageParam, MessagesRequest, ToolParam, ToolResultBlock, ToolUseBlock } from "./anthropic.js";
import { textOf, toolUsesOf } from "./anthropic.js";

export interface ToolCallResult {
  text: string;
  isError: boolean;
  /** Validated arguments (defaults applied), when they were valid. */
  args?: Record<string, unknown>;
}

export interface AgentTool {
  param: ToolParam;
  /** Write tools are previewed with dry_run: true and need approval. */
  write: boolean;
  run(input: Record<string, unknown>): Promise<ToolCallResult>;
}

export interface PendingWrite {
  tool: string;
  args: Record<string, unknown>;
  preview: string;
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; isError: boolean; text: string }
  | { type: "turn_done" };

export interface AgentOptions {
  /** One model call; streams text to onText. */
  send(request: MessagesRequest, onText: (delta: string) => void): Promise<Message>;
  request: Omit<MessagesRequest, "messages" | "tools">;
  tools: AgentTool[];
  maxIterations: number;
  maxToolResultChars: number;
  /** Asked before a write runs for real; absent means writes are refused. */
  approve?(pending: PendingWrite): Promise<boolean>;
  onEvent(event: AgentEvent): void;
  isCancelled(): boolean;
}

export interface AgentOutcome {
  /** The conversation including this turn's assistant and tool messages. */
  messages: MessageParam[];
  text: string;
  /** Why it stopped early, if it did. */
  stopped?: "max_iterations" | "cancelled";
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: ${text.length - max} more characters; ask the tool again with an offset or narrower arguments]`;
}

/** Run one tool call, applying the write gate. */
async function runToolCall(use: ToolUseBlock, options: AgentOptions): Promise<ToolResultBlock> {
  const result = (text: string, isError = false): ToolResultBlock => ({
    type: "tool_result",
    tool_use_id: use.id,
    content: truncate(text, options.maxToolResultChars),
    ...(isError ? { is_error: true } : {}),
  });
  const tool = options.tools.find((t) => t.param.name === use.name);
  if (!tool) return result(`Unknown tool: ${use.name}. Use only the tools you were given.`, true);

  if (!tool.write || use.input.dry_run === true) {
    const r = await tool.run(use.input);
    return result(r.text, r.isError);
  }
  if (!options.approve) return result(`${use.name} can't change the library from this chat.`, true);

  const preview = await tool.run({ ...use.input, dry_run: true });
  if (preview.isError || !preview.args) return result(preview.text, true);
  // Freeze what was previewed: the real call gets these arguments and nothing else.
  const args = JSON.parse(JSON.stringify(preview.args)) as Record<string, unknown>;
  const approved = await options.approve({ tool: use.name, args, preview: preview.text });
  if (options.isCancelled()) return result("Cancelled by the user.", true);
  if (!approved) return result("The user declined this change. Don't retry it unless they ask.", true);
  const real = await tool.run({ ...args, dry_run: false });
  return result(real.text, real.isError);
}

export async function runAgent(history: MessageParam[], options: AgentOptions): Promise<AgentOutcome> {
  const messages = [...history];
  const params = options.tools.map((t) => t.param);
  for (let i = 0; i < options.maxIterations; i++) {
    if (options.isCancelled()) return { messages: history, text: "", stopped: "cancelled" };
    // The last allowed round may not call tools, so the model answers with what it has.
    const last = i === options.maxIterations - 1;
    const reply = await options.send(
      { ...options.request, messages, ...(params.length ? { tools: params, tool_choice: { type: last ? "none" : "auto" } } : {}) },
      (delta) => options.onEvent({ type: "text", delta }),
    );
    const uses = toolUsesOf(reply);
    messages.push({ role: "assistant", content: reply.content as ContentBlock[] });
    if (!uses.length || reply.stop_reason !== "tool_use" || last) {
      if (uses.length && last) {
        // The model ignored tool_choice none: keep the history valid by answering its calls.
        messages.push({ role: "user", content: uses.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, content: "Not run: the tool-use limit was reached.", is_error: true })) });
        options.onEvent({ type: "turn_done" });
        return { messages, text: textOf(reply), stopped: "max_iterations" };
      }
      options.onEvent({ type: "turn_done" });
      return { messages, text: textOf(reply) };
    }
    const results: ToolResultBlock[] = [];
    for (const use of uses) {
      if (options.isCancelled()) return { messages: history, text: "", stopped: "cancelled" };
      options.onEvent({ type: "tool", name: use.name, input: use.input });
      const r = await runToolCall(use, options);
      options.onEvent({ type: "tool_result", name: use.name, isError: Boolean(r.is_error), text: r.content });
      results.push(r);
    }
    messages.push({ role: "user", content: results });
  }
  options.onEvent({ type: "turn_done" });
  return { messages, text: "", stopped: "max_iterations" };
}

/**
 * Keep a conversation under a size budget by replacing the oldest tool results with a short note.
 * The first message (it carries the item context) and the latest turn are never touched.
 */
export function trimHistory(messages: MessageParam[], maxChars: number): MessageParam[] {
  const size = (m: MessageParam) => JSON.stringify(m.content).length;
  let total = messages.reduce((n, m) => n + size(m), 0);
  if (total <= maxChars) return messages;
  const out = messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content }));
  for (let i = 1; i < out.length - 2 && total > maxChars; i++) {
    const content = out[i].content;
    if (!Array.isArray(content)) continue;
    out[i].content = content.map((block) => {
      if (block.type !== "tool_result" || block.content.length < 200) return block;
      total -= block.content.length;
      return { ...block, content: "[removed to save space; call the tool again if you need it]" };
    });
  }
  return out;
}
