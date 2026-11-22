import { describe, expect, it } from "vitest";
import type { MessageParam } from "../../src/assistant/anthropic.js";
import { OpenAIStreamAccumulator, fromOpenAIResponse, toOpenAIRequest } from "../../src/assistant/openai.js";

const history: MessageParam[] = [
  { role: "user", content: "Tag ABCD2345" },
  { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "Looking." }, { type: "tool_use", id: "tu_1", name: "zotero_set_tags", input: { item_keys: ["ABCD2345"], add: ["x"] } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "Nothing to change", is_error: true }] },
];

describe("toOpenAIRequest", () => {
  it("maps system, messages, tool calls and tool results", () => {
    const req = toOpenAIRequest({ model: "m", max_tokens: 100, system: "sys", messages: history, tools: [{ name: "zotero_set_tags", description: "d", input_schema: { type: "object" } }], tool_choice: { type: "auto" } }, "max_completion_tokens", true);
    expect(req).toEqual({
      model: "m",
      max_completion_tokens: 100,
      stream: true,
      tool_choice: "auto",
      tools: [{ type: "function", function: { name: "zotero_set_tags", description: "d", parameters: { type: "object" } } }],
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "Tag ABCD2345" },
        { role: "assistant", content: "Looking.", tool_calls: [{ id: "tu_1", type: "function", function: { name: "zotero_set_tags", arguments: '{"item_keys":["ABCD2345"],"add":["x"]}' } }] },
        { role: "tool", tool_call_id: "tu_1", content: "Error: Nothing to change" },
      ],
    });
  });

  it("maps forced, any and none tool choices, and the older token field", () => {
    const base = { model: "m", max_tokens: 5, messages: [] as MessageParam[] };
    expect(toOpenAIRequest({ ...base, tool_choice: { type: "tool", name: "propose_tags" } }, "max_tokens", false)).toMatchObject({ max_tokens: 5, tool_choice: { type: "function", function: { name: "propose_tags" } } });
    expect(toOpenAIRequest({ ...base, tool_choice: { type: "any" } }, "max_tokens", false).tool_choice).toBe("required");
    expect(toOpenAIRequest({ ...base, tool_choice: { type: "none" } }, "max_tokens", false).tool_choice).toBe("none");
  });
});

describe("replies", () => {
  it("reads a whole reply with text and tool calls", () => {
    const m = fromOpenAIResponse({ model: "gpt", choices: [{ finish_reason: "tool_calls", message: { content: "Hi", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: '{"a":1}' } }] } }] });
    expect(m).toEqual({ model: "gpt", stop_reason: "tool_use", content: [{ type: "text", text: "Hi" }, { type: "tool_use", id: "c1", name: "t", input: { a: 1 } }] });
    expect(fromOpenAIResponse({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }).stop_reason).toBe("end_turn");
    expect(() => fromOpenAIResponse({ error: { message: "x" } })).toThrow();
  });

  it("builds a streamed reply whatever the chunking, with tool-call argument fragments", () => {
    const events = [
      { model: "gpt", choices: [{ delta: { role: "assistant", content: "Look" } }] },
      { choices: [{ delta: { content: "ing – ü" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "zotero_search_items", arguments: '{"que' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"k8s"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const wire = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
    const expected = { model: "gpt", stop_reason: "tool_use", content: [{ type: "text", text: "Looking – ü" }, { type: "tool_use", id: "c1", name: "zotero_search_items", input: { query: "k8s" } }] };
    for (let size = 1; size < 40; size += 7) {
      const deltas: string[] = [];
      const a = new OpenAIStreamAccumulator((d) => deltas.push(d));
      for (let i = 0; i < wire.length; i += size) a.push(wire.slice(i, i + size));
      expect(a.message(), `chunk ${size}`).toEqual(expected);
      expect(deltas.join("")).toBe("Looking – ü");
    }
  });

  it("raises a streamed error and refuses a stream that ended early", () => {
    expect(() => new OpenAIStreamAccumulator().push(`data: ${JSON.stringify({ error: { message: "quota" } })}\n`)).toThrow(/quota/);
    const a = new OpenAIStreamAccumulator();
    a.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n`);
    expect(() => a.message()).toThrow(/ended early/);
  });
});
