import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpServer } from "../../src/mcp/server.js";
import { ToolError, defineTool } from "../../src/mcp/tool.js";

const echo = defineTool({
  name: "echo",
  title: "Echo",
  description: "Echo a word",
  input: z.object({ word: z.string().min(1), times: z.number().int().default(1) }),
  annotations: { readOnlyHint: true },
  async run(args) {
    return { summary: `echo ${args.word}`, data: { words: Array(args.times).fill(args.word) } };
  },
});

const failing = defineTool({
  name: "failing",
  title: "Failing",
  description: "Always fails",
  input: z.object({ kind: z.enum(["user", "bug"]) }),
  annotations: {},
  async run(args) {
    if (args.kind === "user") throw new ToolError("bad key ABCD2345");
    throw new Error("boom");
  },
});

function server(logError = vi.fn(), ready?: () => Promise<void>) {
  return new McpServer({
    info: { name: "test", title: "Test", version: "1.2.3", instructions: "be nice" },
    tools: [echo, failing],
    logError,
    ready,
  });
}

const call = (name: string, args: unknown) => ({ jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: { name, arguments: args } });

describe("McpServer", () => {
  it("initialize negotiates the version and declares tools", async () => {
    const res = await server().handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(res).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "test", title: "Test", version: "1.2.3" },
        instructions: "be nice",
      },
    });
  });

  it("answers ping with an empty result", async () => {
    expect(await server().handleRequest({ jsonrpc: "2.0", id: "p", method: "ping" })).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  it("lists tools with JSON Schema input (no $schema) and annotations", async () => {
    const res = await server().handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    if (!("result" in res)) throw new Error("expected result");
    const tools = res.result.tools as Array<Record<string, unknown>>;
    expect(tools.map((t) => t.name)).toEqual(["echo", "failing"]);
    const schema = tools[0].inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.$schema).toBeUndefined();
    expect(schema.required).toEqual(["word"]);
    expect(schema.additionalProperties).toBe(false);
    expect(tools[0].annotations).toEqual({ title: "Echo", readOnlyHint: true });
  });

  it("runs a tool with defaults applied", async () => {
    const res = await server().handleRequest(call("echo", { word: "hi", times: 2 }));
    expect(res).toMatchObject({ result: { isError: false } });
    if ("result" in res) {
      const text = (res.result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("echo hi");
      expect(JSON.parse(text.slice(text.indexOf("\n\n") + 2))).toEqual({ words: ["hi", "hi"] });
    }
  });

  it("reports invalid arguments as a tool error the model can fix", async () => {
    const res = await server().handleRequest(call("echo", { word: "" }));
    expect(res).toMatchObject({ result: { isError: true } });
    if ("result" in res) expect((res.result.content as Array<{ text: string }>)[0].text).toMatch(/Invalid arguments for echo/);
  });

  it("rejects a misspelled argument instead of silently ignoring it", async () => {
    const res = await server().handleRequest(call("echo", { word: "hi", tmes: 2 }));
    expect(res).toMatchObject({ result: { isError: true } });
    if ("result" in res) expect((res.result.content as Array<{ text: string }>)[0].text).toMatch(/Unrecognized key.*tmes/);
  });

  it("returns -32602 for an unknown tool", async () => {
    expect(await server().handleRequest(call("nope", {}))).toMatchObject({ error: { code: -32602 } });
  });

  it("returns -32601 for an unknown method", async () => {
    expect(await server().handleRequest({ jsonrpc: "2.0", id: 1, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
  });

  it("ToolError is reported but not logged; other errors are logged too", async () => {
    const log = vi.fn();
    const s = server(log);
    expect(await s.handleRequest(call("failing", { kind: "user" }))).toMatchObject({ result: { isError: true } });
    expect(log).not.toHaveBeenCalled();
    expect(await s.handleRequest(call("failing", { kind: "bug" }))).toMatchObject({ result: { isError: true } });
    expect(log).toHaveBeenCalledOnce();
  });

  it("waits for ready() before running a tool", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pending = server(vi.fn(), () => gate).handleRequest(call("echo", { word: "x" }));
    let settled = false;
    void pending.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    release();
    expect(await pending).toMatchObject({ result: { isError: false } });
  });

  it("rejects duplicate tool names", () => {
    expect(() => new McpServer({ info: { name: "t", title: "T", version: "1" }, tools: [echo, echo] })).toThrow(/Duplicate/);
  });
});
