import { describe, expect, it } from "vitest";
import { StreamAccumulator } from "../../src/assistant/sse.js";

const events = [
  { type: "message_start", message: { model: "glm-4.7", content: [] } },
  { type: "ping" },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig==" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Looking it " } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "up – ünïcode." } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_1", name: "zotero_search_items", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"query": "kube' } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: 'rnetes", "limit": 5}' } },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
  { type: "message_stop" },
];
const wire = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const expected = {
  model: "glm-4.7",
  content: [
    { type: "thinking", thinking: "hmm", signature: "sig==" },
    { type: "text", text: "Looking it up – ünïcode." },
    { type: "tool_use", id: "tu_1", name: "zotero_search_items", input: { query: "kubernetes", limit: 5 } },
  ],
  stop_reason: "tool_use",
};

describe("StreamAccumulator", () => {
  it("builds the message, keeps thinking with its signature, and streams only the text", () => {
    const deltas: string[] = [];
    const a = new StreamAccumulator((d) => deltas.push(d));
    a.push(wire);
    expect(a.message()).toEqual(expected);
    expect(deltas.join("")).toBe("Looking it up – ünïcode.");
  });

  it("gives the same message whatever the chunk boundaries", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const a = new StreamAccumulator();
      let i = 0;
      let x = seed;
      while (i < wire.length) {
        x = (x * 1103515245 + 12345) % 2 ** 31;
        const n = 1 + (x % 40);
        a.push(wire.slice(i, i + n));
        i += n;
      }
      expect(a.message(), `seed ${seed}`).toEqual(expected);
    }
  });

  it("handles CRLF line endings", () => {
    const a = new StreamAccumulator();
    a.push(wire.replace(/\n/g, "\r\n"));
    expect(a.message()).toEqual(expected);
  });

  it("raises an error event and refuses a stream that ended early", () => {
    expect(() => new StreamAccumulator().push(`data: ${JSON.stringify({ type: "error", error: { message: "overloaded" } })}\n\n`)).toThrow(/overloaded/);
    const a = new StreamAccumulator();
    a.push(wire.slice(0, wire.indexOf("message_stop") - 20));
    expect(() => a.message()).toThrow(/ended early/);
  });
});
