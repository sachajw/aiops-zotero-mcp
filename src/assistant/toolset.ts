/**
 * Which of the plugin's tools a chat may use, as AgentTools. Pure apart from what the tools do
 * when run (that's Zotero's side, through runTool).
 */
import { type RunOptions, runTool } from "../mcp/runner.js";
import type { ToolDefinition } from "../mcp/tool.js";
import { toolParam } from "./anthropic.js";
import type { AgentTool } from "./agent.js";

/**
 * Never offered to a model: zotero_add_file reads any file on this computer and switches a Zotero
 * setting while it runs; zotero_retrieve_metadata sends documents to an outside service.
 */
export const NEVER_OFFERED = new Set(["zotero_add_file", "zotero_retrieve_metadata"]);

export function isReadOnly(tool: ToolDefinition): boolean {
  return tool.annotations.readOnlyHint === true;
}

export function agentTools(tools: ToolDefinition[], { writes }: { writes: boolean }, options: RunOptions = {}): AgentTool[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return tools
    .filter((t) => !NEVER_OFFERED.has(t.name) && (writes || isReadOnly(t)))
    .map((t) => ({
      param: toolParam(t),
      write: !isReadOnly(t),
      async run(input) {
        const r = await runTool(byName, t.name, input, options);
        return r.kind === "unknown" ? { text: `Unknown tool: ${r.name}`, isError: true } : { text: r.text, isError: r.isError, args: r.args };
      },
    }));
}
