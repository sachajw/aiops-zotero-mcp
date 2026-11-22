import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type AgentOptions, type AgentTool, runAgent, trimHistory, truncate } from "../../src/assistant/agent.js";
import type { Message, MessageParam, MessagesRequest } from "../../src/assistant/anthropic.js";
import { NEVER_OFFERED, agentTools } from "../../src/assistant/toolset.js";
import { defineTool } from "../../src/mcp/tool.js";
import { readTools } from "../../src/tools/read.js";
import { writeTools } from "../../src/tools/write.js";

const text = (t: string): Message => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const uses = (...calls: Array<[string, Record<string, unknown>]>): Message => ({
  content: calls.map(([name, input], i) => ({ type: "tool_use" as const, id: `tu_${i}`, name, input })),
  stop_reason: "tool_use",
});

function scripted(replies: Message[]) {
  const requests: MessagesRequest[] = [];
  return {
    requests,
    send: vi.fn(async (req: MessagesRequest, onText: (d: string) => void) => {
      requests.push(JSON.parse(JSON.stringify(req)));
      const r = replies.shift();
      if (!r) throw new Error("no more scripted replies");
      for (const b of r.content) if (b.type === "text") onText(b.text);
      return r;
    }),
  };
}

const writes: Array<Record<string, unknown>> = [];
const search: AgentTool = { param: { name: "search", description: "s", input_schema: { type: "object" } }, write: false, run: async (i) => ({ text: `found ${String(i.q)}`, isError: false }) };
const tag: AgentTool = {
  param: { name: "tag", description: "t", input_schema: { type: "object" } },
  write: true,
  run: async (i) => {
    const args = { keys: i.keys, add: i.add, dry_run: i.dry_run ?? false };
    if (!args.dry_run) writes.push(args);
    return { text: args.dry_run ? `would tag ${String(i.keys)}` : `tagged ${String(i.keys)}`, isError: false, args };
  },
};

function options(send: AgentOptions["send"], extra: Partial<AgentOptions> = {}): AgentOptions {
  return { send, request: { model: "m", max_tokens: 100 }, tools: [search, tag], maxIterations: 5, maxToolResultChars: 1000, onEvent: () => {}, isCancelled: () => false, ...extra };
}

describe("runAgent", () => {
  it("runs read tools and sends their results back in order, then returns the answer", async () => {
    const s = scripted([uses(["search", { q: "a" }], ["search", { q: "b" }]), text("Two hits.")]);
    const out = await runAgent([{ role: "user", content: "find" }], options(s.send));
    expect(out.text).toBe("Two hits.");
    expect(s.requests[1].messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_0", content: "found a" },
        { type: "tool_result", tool_use_id: "tu_1", content: "found b" },
      ],
    });
    expect(s.requests[0].tool_choice).toEqual({ type: "auto" });
  });

  it("refuses writes when there's no approver", async () => {
    writes.length = 0;
    const s = scripted([uses(["tag", { keys: ["K"], add: ["x"] }]), text("ok")]);
    await runAgent([{ role: "user", content: "tag" }], options(s.send));
    expect(writes).toEqual([]);
    expect(s.requests[1].messages.at(-1)?.content).toEqual([expect.objectContaining({ is_error: true, content: expect.stringMatching(/can't change the library/) })]);
  });

  it("previews a write, and runs exactly the previewed arguments once approved", async () => {
    writes.length = 0;
    const approve = vi.fn(async () => true);
    const s = scripted([uses(["tag", { keys: ["K"], add: ["x"] }]), text("done")]);
    await runAgent([{ role: "user", content: "tag" }], options(s.send, { approve }));
    expect(approve).toHaveBeenCalledWith({ tool: "tag", args: { keys: ["K"], add: ["x"], dry_run: true }, preview: "would tag K" });
    expect(writes).toEqual([{ keys: ["K"], add: ["x"], dry_run: false }]);
  });

  it("changes nothing when the user declines, and tells the model", async () => {
    writes.length = 0;
    const s = scripted([uses(["tag", { keys: ["K"], add: ["x"] }]), text("ok")]);
    await runAgent([{ role: "user", content: "tag" }], options(s.send, { approve: async () => false }));
    expect(writes).toEqual([]);
    expect(JSON.stringify(s.requests[1].messages.at(-1))).toMatch(/declined/);
  });

  it("reports unknown tools to the model, stops at the iteration limit, and on cancel keeps history unchanged", async () => {
    const s = scripted([uses(["nope", {}]), uses(["search", { q: "x" }]), uses(["search", { q: "y" }])]);
    const out = await runAgent([{ role: "user", content: "go" }], options(s.send, { maxIterations: 2 }));
    expect(JSON.stringify(s.requests[1].messages.at(-1))).toMatch(/Unknown tool: nope/);
    expect(s.requests[0].tool_choice).toEqual({ type: "auto" });
    expect(s.requests[1].tool_choice).toEqual({ type: "none" });
    // The model ignored "none": its calls get error results, so the history stays valid.
    expect(out.stopped).toBe("max_iterations");
    expect(out.messages.at(-1)).toMatchObject({ role: "user", content: [expect.objectContaining({ is_error: true })] });

    const s3 = scripted([uses(["search", { q: "x" }]), text("Answer from what I found.")]);
    const out3 = await runAgent([{ role: "user", content: "go" }], options(s3.send, { maxIterations: 2 }));
    expect(out3).toMatchObject({ text: "Answer from what I found." });
    expect(out3.stopped).toBeUndefined();

    const history: MessageParam[] = [{ role: "user", content: "go" }];
    let cancelled = false;
    const s2 = scripted([uses(["search", { q: "x" }])]);
    s2.send.mockImplementationOnce(async () => { cancelled = true; return uses(["search", { q: "x" }]); });
    const out2 = await runAgent(history, options(s2.send, { isCancelled: () => cancelled }));
    expect(out2).toEqual({ messages: history, text: "", stopped: "cancelled" });
  });
});

describe("history and limits", () => {
  it("truncates long tool output with a note", () => {
    expect(truncate("abcdef", 3)).toMatch(/^abc\n\[truncated: 3 more characters/);
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("replaces the oldest tool results first, never the first message or the latest turn", () => {
    const big = "x".repeat(500);
    const msgs: MessageParam[] = [
      { role: "user", content: big },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "s", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: big }] },
      { role: "assistant", content: [{ type: "tool_use", id: "b", name: "s", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: big }] },
    ];
    const out = trimHistory(msgs, 1200);
    expect(JSON.stringify(out[2])).toMatch(/removed to save space/);
    expect(out[0]).toEqual(msgs[0]);
    expect(out[4]).toEqual(msgs[4]);
    expect(trimHistory(msgs, 1e6)).toBe(msgs);
  });
});

describe("agentTools", () => {
  const all = [...readTools, ...writeTools] as never[];

  it("offers read tools only unless writes are allowed, and never the excluded ones", () => {
    const reads = agentTools(all, { writes: false });
    expect(reads.every((t) => !t.write)).toBe(true);
    expect(reads.map((t) => t.param.name)).toContain("zotero_get_fulltext");
    const withWrites = agentTools(all, { writes: true }).map((t) => t.param.name);
    expect(withWrites).toContain("zotero_set_tags");
    for (const n of NEVER_OFFERED) expect(withWrites).not.toContain(n);
  });

  it("gives every tool a strict object schema the Messages API accepts", () => {
    for (const t of agentTools(all, { writes: true })) {
      expect(t.param.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(t.param.input_schema).toMatchObject({ type: "object", additionalProperties: false });
      expect(t.param.input_schema).not.toHaveProperty("$schema");
    }
  });

  it("runs a tool through the shared runner, returning validated args", async () => {
    const echo = defineTool({ name: "echo", title: "E", description: "e", input: z.object({ n: z.number().default(2) }), annotations: { readOnlyHint: true }, run: async (a) => ({ summary: `n=${a.n}` }) });
    const [t] = agentTools([echo as never], { writes: false });
    expect(await t.run({})).toEqual({ text: "n=2", isError: false, args: { n: 2 } });
    expect((await t.run({ m: 1 })).isError).toBe(true);
  });
});
