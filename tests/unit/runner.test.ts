import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { formatOutput, runTool } from "../../src/mcp/runner.js";
import { ToolError, defineTool } from "../../src/mcp/tool.js";

const echo = defineTool({
  name: "echo",
  title: "Echo",
  description: "Echo",
  input: z.object({ word: z.string().min(1), times: z.number().int().default(1) }),
  annotations: {},
  async run(args) {
    if (args.word === "user") throw new ToolError("bad word");
    if (args.word === "bug") throw new Error("boom");
    return { summary: `echo ${args.word}`, data: { times: args.times } };
  },
});
const tools = new Map([[echo.name, echo]]) as never;

describe("runTool", () => {
  it("returns the formatted output and the parsed args with defaults", async () => {
    const run = await runTool(tools, "echo", { word: "hi" });
    expect(run).toMatchObject({ kind: "result", isError: false, args: { word: "hi", times: 1 } });
    if (run.kind === "result") expect(run.text).toBe('echo hi\n\n{\n  "times": 1\n}');
  });

  it("reports an unknown tool without running anything", async () => {
    expect(await runTool(tools, "nope", {})).toEqual({ kind: "unknown", name: "nope" });
  });

  it("reports invalid and unknown arguments as errors", async () => {
    const bad = await runTool(tools, "echo", { word: "" });
    expect(bad).toMatchObject({ kind: "result", isError: true });
    const extra = await runTool(tools, "echo", { word: "hi", wrod: 1 });
    expect(extra.kind === "result" && extra.text).toMatch(/Unrecognized key/);
  });

  it("logs unexpected errors but not ToolErrors", async () => {
    const logError = vi.fn();
    expect(await runTool(tools, "echo", { word: "user" }, { logError })).toMatchObject({ isError: true, text: "bad word" });
    expect(logError).not.toHaveBeenCalled();
    expect(await runTool(tools, "echo", { word: "bug" }, { logError })).toMatchObject({ isError: true, text: "boom" });
    expect(logError).toHaveBeenCalledOnce();
  });

  it("formats output without data as just the summary", () => {
    expect(formatOutput({ summary: "ok" })).toBe("ok");
  });
});
