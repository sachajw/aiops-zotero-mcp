/**
 * Builds a Message from the Messages API's server-sent events (stream: true), fed in chunks that
 * may split anywhere. Text arrives through onText as it streams; thinking blocks are kept (they
 * must go back to the API) but never streamed to the reader. Pure.
 */
import { ToolError } from "../mcp/tool.js";
import type { Message, ReplyBlock } from "./anthropic.js";

type Building =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; json: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "other" };

export class StreamAccumulator {
  private buffer = "";
  private blocks = new Map<number, Building>();
  private model: string | undefined;
  private stopReason: string | null = null;
  private finished = false;

  constructor(private readonly onText: (delta: string) => void = () => {}) {}

  /** Feed raw text from the response body; complete events are applied, the rest waits. */
  push(chunk: string): void {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    let end: number;
    while ((end = this.buffer.indexOf("\n\n")) >= 0) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const data = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) this.apply(data);
    }
  }

  private apply(data: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return; // not JSON (e.g. a keep-alive comment)
    }
    const index = typeof event.index === "number" ? event.index : -1;
    switch (event.type) {
      case "message_start": {
        const message = event.message as { model?: string } | undefined;
        this.model = message?.model;
        break;
      }
      case "content_block_start": {
        const block = event.content_block as
          | { type?: string; text?: string; id?: string; name?: string; thinking?: string; signature?: string; data?: string }
          | undefined;
        if (block?.type === "text") this.blocks.set(index, { type: "text", text: "" });
        else if (block?.type === "tool_use") this.blocks.set(index, { type: "tool_use", id: String(block.id), name: String(block.name), json: "" });
        else if (block?.type === "thinking") this.blocks.set(index, { type: "thinking", thinking: block.thinking ?? "", signature: block.signature ?? "" });
        else if (block?.type === "redacted_thinking") this.blocks.set(index, { type: "redacted_thinking", data: block.data ?? "" });
        else this.blocks.set(index, { type: "other" });
        if (block?.type === "text" && block.text) this.addText(index, block.text);
        break;
      }
      case "content_block_delta": {
        const delta = event.delta as { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string } | undefined;
        const block = this.blocks.get(index);
        if (delta?.type === "text_delta" && typeof delta.text === "string") this.addText(index, delta.text);
        else if (delta?.type === "input_json_delta" && block?.type === "tool_use") block.json += delta.partial_json ?? "";
        else if (delta?.type === "thinking_delta" && block?.type === "thinking") block.thinking += delta.thinking ?? "";
        else if (delta?.type === "signature_delta" && block?.type === "thinking") block.signature += delta.signature ?? "";
        break;
      }
      case "message_delta": {
        const delta = event.delta as { stop_reason?: string | null } | undefined;
        if (delta && "stop_reason" in delta) this.stopReason = delta.stop_reason ?? null;
        break;
      }
      case "message_stop":
        this.finished = true;
        break;
      case "error": {
        const error = event.error as { message?: string } | undefined;
        throw new ToolError(`The model stopped with an error: ${error?.message ?? "unknown error"}`);
      }
    }
  }

  private addText(index: number, text: string): void {
    const block = this.blocks.get(index);
    if (block?.type !== "text") return;
    block.text += text;
    this.onText(text);
  }

  /** The finished message. Throws if the stream ended before message_stop. */
  message(): Message {
    if (!this.finished) throw new ToolError("The reply stream ended early");
    const content: ReplyBlock[] = [];
    for (const [, block] of [...this.blocks].sort(([a], [b]) => a - b)) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      if (block.type === "thinking") content.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
      if (block.type === "redacted_thinking") content.push({ type: "redacted_thinking", data: block.data });
      if (block.type === "tool_use") {
        let input: unknown;
        try {
          input = block.json.trim() ? JSON.parse(block.json) : {};
        } catch {
          input = {}; // malformed arguments: the tool's own validation reports what's missing
        }
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {},
        });
      }
    }
    return { model: this.model, content, stop_reason: this.stopReason };
  }
}
