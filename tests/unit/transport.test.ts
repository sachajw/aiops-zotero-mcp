import { describe, expect, it, vi } from "vitest";
import { parseMessage } from "../../src/assistant/anthropic.js";
import type { Backend } from "../../src/assistant/config.js";
import { CancelledError, send } from "../../src/assistant/transport.js";

const backend: Backend = { label: "zai", file: "/a/zai.settings.json", baseURL: "http://127.0.0.1:8788", token: "secret", models: { default: "m" } };
const ok = { role: "assistant", model: "glm", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "hi" }], stop_reason: "end_turn" };

function deps(respond: (url: string, init: Record<string, unknown>) => Promise<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  return {
    calls,
    deps: {
      fetch: async (url: string, init: Record<string, unknown>) => {
        calls.push({ url, init });
        const r = await respond(url, init);
        return { status: r.status, json: async () => r.body, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
      },
      AbortController,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
  };
}

describe("send", () => {
  it("posts to /v1/messages without streaming, and keeps only usable blocks", async () => {
    const d = deps(async () => ({ status: 200, body: ok }));
    const m = await send(d.deps, backend, { model: "m", max_tokens: 10, messages: [{ role: "user", content: "x" }], stream: true }, { timeoutSeconds: 5 });
    expect(m).toEqual({ model: "glm", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" });
    expect(d.calls[0].url).toBe("http://127.0.0.1:8788/v1/messages");
    expect(JSON.parse(d.calls[0].init.body as string).stream).toBe(false);
    expect(d.calls[0].init.headers).toMatchObject({ authorization: "Bearer secret" });
  });

  it("explains an auth failure without echoing the token", async () => {
    const d = deps(async () => ({ status: 401, body: { type: "error", error: { type: "authentication_error", message: "x-api-key header is required" } } }));
    const err = await send(d.deps, backend, { model: "m", max_tokens: 1, messages: [] }, { timeoutSeconds: 5 }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 401: x-api-key header is required\. Check ANTHROPIC_AUTH_TOKEN in \/a\/zai\.settings\.json/);
    expect((err as Error).message).not.toContain("secret");
  });

  it("says the proxy may be down when it can't connect", async () => {
    const d = deps(async () => { throw new TypeError("NetworkError"); });
    await expect(send(d.deps, backend, { model: "m", max_tokens: 1, messages: [] }, { timeoutSeconds: 5 })).rejects.toThrow(/Can't reach zai .* Is the proxy running/);
  });

  it("can be cancelled", async () => {
    const d = deps((_url, init) => new Promise((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const cancel = vi.fn<(c: () => void) => void>();
    const pending = send(d.deps, backend, { model: "m", max_tokens: 1, messages: [] }, { timeoutSeconds: 5, onCancel: cancel });
    cancel.mock.calls[0][0]();
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  });

  it("refuses a body that isn't a Messages reply", () => {
    expect(() => parseMessage({ foo: 1 })).toThrow();
  });
});
