/**
 * Runs one tool by name: validate the arguments with its zod schema, wait for readiness, run it,
 * and turn the outcome into text. Shared by the MCP server (tools/call) and the in-Zotero assistant,
 * so both see exactly the same validation, errors and output.
 */
import { z } from "zod";
import { type ToolDefinition, type ToolOutput, ToolError } from "./tool.js";

export interface RunOptions {
  /** Awaited before the tool runs, e.g. Zotero.initializationPromise. */
  ready?: () => Promise<void>;
  /** Where unexpected failures are logged (ToolErrors are the caller's to fix, so they aren't). */
  logError?: (error: unknown) => void;
}

export type ToolRun =
  | { kind: "unknown"; name: string }
  | {
      kind: "result";
      text: string;
      isError: boolean;
      /** The tool's own output, when it succeeded. */
      output?: ToolOutput;
      /** The arguments after validation, with defaults applied, when they were valid. */
      args?: Record<string, unknown>;
    };

/** Summary, then the data as pretty JSON: the text every client sees. */
export function formatOutput(output: ToolOutput): string {
  return output.data === undefined ? output.summary : `${output.summary}\n\n${JSON.stringify(output.data, null, 2)}`;
}

export async function runTool(
  tools: ReadonlyMap<string, ToolDefinition>,
  name: unknown,
  rawArgs: unknown,
  options: RunOptions = {},
): Promise<ToolRun> {
  const tool = typeof name === "string" ? tools.get(name) : undefined;
  if (!tool) return { kind: "unknown", name: String(name) };

  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { kind: "result", isError: true, text: `Invalid arguments for ${tool.name}:\n${z.prettifyError(parsed.error)}` };
  }
  const args = parsed.data as Record<string, unknown>;

  try {
    await options.ready?.();
    const output = await tool.run(parsed.data);
    return { kind: "result", isError: false, text: formatOutput(output), output, args };
  } catch (error) {
    if (!(error instanceof ToolError)) options.logError?.(error);
    return { kind: "result", isError: true, text: error instanceof Error ? error.message : String(error), args };
  }
}
