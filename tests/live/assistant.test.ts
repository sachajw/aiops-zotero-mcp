/**
 * Live tests for the assistant's transport and prompts, against real local proxies.
 *
 * Needs AIOPS_LLM_PROFILE_FILES: absolute paths to Claude-Code-style settings files, separated by
 * newlines or commas (e.g. ~/.ccs/zai.settings.json,~/.ccs/claude.settings.json). Skips without it.
 * Sends a made-up item, never library content.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCollectionProposal, parseSummary, parseTagProposal, collectionsRequest, summaryRequest, tagsRequest, type ItemContext } from "../../src/assistant/actions.js";
import { parseProfile, profileFiles, resolveModel } from "../../src/assistant/config.js";
import { send } from "../../src/assistant/transport.js";

const files = profileFiles(process.env.AIOPS_LLM_PROFILE_FILES);
const deps = {
  fetch: (url: string, init: Record<string, unknown>) => fetch(url, init as RequestInit),
  AbortController,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
const ctx: ItemContext = {
  key: "ABCD2345", itemType: "book", title: "Kubernetes Patterns", creators: ["Bilgin Ibryam", "Roland Huß"], date: "2019",
  abstract: "Reusable elements for designing cloud-native applications on Kubernetes.", tags: [], collectionPaths: [],
};

describe.skipIf(!files.length)("assistant against live proxies", () => {
  for (const file of files) {
    const backend = parseProfile(readFileSync(file, "utf8"), file);
    const model = resolveModel(backend, process.env.AIOPS_LLM_MODEL ?? "haiku");
    const opts = { timeoutSeconds: 90 };

    describe(`${backend.label} (${model})`, () => {
      it("summarises", async () => {
        expect(parseSummary(await send(deps, backend, summaryRequest(ctx, model, 600), opts)).length).toBeGreaterThan(20);
      }, 120_000);

      it("proposes existing tags through the forced tool", async () => {
        const library = ["Kubernetes", "Containers", "Cloud computing", "Brewing"];
        const p = parseTagProposal(await send(deps, backend, tagsRequest(ctx, library, model, 4096), opts), library, []);
        expect(p.existing).toContain("Kubernetes");
        expect(p.existing).not.toContain("Brewing");
      }, 120_000);

      it("proposes a real collection", async () => {
        const collections = [{ key: "AAAA2222", path: "Library / Brew" }, { key: "BBBB2222", path: "Platform Engineering / Cloud Native / Orchestrator / K8s" }];
        const s = parseCollectionProposal(await send(deps, backend, collectionsRequest(ctx, collections, model, 4096), opts), collections, []);
        expect(s[0]?.key).toBe("BBBB2222");
      }, 120_000);
    });
  }
});

import { runAgent } from "../../src/assistant/agent.js";
import { chatSystem } from "../../src/assistant/chat.js";
import { agentTools } from "../../src/assistant/toolset.js";
import { readTools } from "../../src/tools/read.js";

describe.skipIf(!files.length)("item chat against live proxies", () => {
  for (const file of files) {
    const backend = parseProfile(readFileSync(file, "utf8"), file);
    const model = resolveModel(backend, process.env.AIOPS_LLM_MODEL ?? "sonnet");

    it(`${backend.label} (${model}) streams and runs a tool round trip with every real read-tool schema`, async () => {
      // Real schemas, fake runs: no Zotero here, so tools answer with canned text.
      const tools = agentTools(readTools as never, { writes: false }).map((t) => ({
        ...t,
        run: async (input: Record<string, unknown>) => ({ text: `${t.param.name} → ${JSON.stringify(input)}: "Chapter 3: the Sidecar pattern adds a helper container next to the main one."`, isError: false }),
      }));
      let streamed = "";
      const used: string[] = [];
      const out = await runAgent([{ role: "user", content: "What does chapter 3 cover? Read further into the text to check before answering." }], {
        send: (req, onText) => send(deps, backend, req, { timeoutSeconds: 120, onText }),
        request: { model, max_tokens: 4096, system: chatSystem({ ...ctx, fulltext: { text: "Contents: 1 Intro, 2 Pods, 3 ...", totalChars: 90000, attachmentKey: "EFGH2345" } }) },
        tools,
        maxIterations: 5,
        maxToolResultChars: 5000,
        onEvent: (e) => {
          if (e.type === "text") streamed += e.delta;
          if (e.type === "tool") used.push(e.name);
        },
        isCancelled: () => false,
      });
      expect(used.length).toBeGreaterThan(0);
      expect(out.text.length).toBeGreaterThan(10);
      expect(streamed).toContain(out.text.slice(0, 20));
      expect(out.text.toLowerCase()).toContain("sidecar");
    }, 240_000);
  }
});

import { librarySystem } from "../../src/assistant/chat.js";
import { writeTools } from "../../src/tools/write.js";

describe.skipIf(!files.length)("library assistant against live proxies", () => {
  for (const file of files) {
    const backend = parseProfile(readFileSync(file, "utf8"), file);
    const model = resolveModel(backend, process.env.AIOPS_LLM_MODEL ?? "sonnet");

    it(`${backend.label} (${model}) asks for approval before tagging, with the right arguments`, async () => {
      // Real schemas, fake runs: searches find one item; writes echo their arguments.
      const tools = agentTools([...readTools, ...writeTools] as never, { writes: true }).map((t) => ({
        ...t,
        run: async (input: Record<string, unknown>) => {
          if (!t.write) return { text: `${t.param.name}: 1 matching item\n{"items":[{"key":"KXPT7Q2M","itemType":"book","title":"Kubernetes Patterns"}]}`, isError: false };
          // Like the real add/remove tools: a call that changes nothing is an error, even as a dry run.
          const empty = (v: unknown) => !Array.isArray(v) || v.length === 0;
          if (["zotero_set_tags", "zotero_set_collections"].includes(t.param.name) && empty(input.add) && empty(input.remove)) {
            return { text: "Nothing to change: give add and/or remove", isError: true };
          }
          return { text: `${input.dry_run ? "Dry run, nothing changed. Would" : "Did"} ${t.param.name} ${JSON.stringify(input)}`, isError: false, args: input };
        },
      }));
      const approvals: Array<{ tool: string; args: Record<string, unknown> }> = [];
      const out = await runAgent([{ role: "user", content: "Find my book 'Kubernetes Patterns' and add the tag Kubernetes to it." }], {
        send: (req, onText) => send(deps, backend, req, { timeoutSeconds: 120, onText }),
        request: { model, max_tokens: 4096, system: librarySystem() },
        tools,
        maxIterations: 6,
        maxToolResultChars: 5000,
        approve: async (p) => {
          approvals.push({ tool: p.tool, args: p.args });
          return true;
        },
        onEvent: () => {},
        isCancelled: () => false,
      });
      expect(approvals.length).toBe(1);
      expect(approvals[0].tool).toBe("zotero_set_tags");
      expect(approvals[0].args).toMatchObject({ item_keys: ["KXPT7Q2M"], add: ["Kubernetes"], dry_run: true });
      expect(out.text.length).toBeGreaterThan(0);
    }, 240_000);
  }
});
