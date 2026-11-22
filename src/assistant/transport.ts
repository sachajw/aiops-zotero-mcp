/**
 * Sends a Messages request to a backend's local proxy. fetch and AbortController are injected:
 * the plugin's sandbox has fetch but no AbortController, so Zotero passes the main window's.
 */
import { ToolError } from "../mcp/tool.js";
import { type Message, type MessagesRequest, errorMessage, parseMessage } from "./anthropic.js";
import type { Backend } from "./config.js";
import { OpenAIStreamAccumulator, fromOpenAIResponse, toOpenAIRequest } from "./openai.js";
import { StreamAccumulator } from "./sse.js";

export const ANTHROPIC_VERSION = "2023-06-01";

export interface FetchResponse {
  status: number;
  text(): Promise<string>;
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
}

export interface TransportDeps {
  fetch: (url: string, init: Record<string, unknown>) => Promise<FetchResponse>;
  AbortController: new () => { signal: unknown; abort(reason?: unknown): void };
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface SendOptions {
  timeoutSeconds: number;
  /** Called with a function that cancels this request (for a Stop button). */
  onCancel?: (cancel: () => void) => void;
  /** Stream the reply, passing text to this as it arrives. Without it the request doesn't stream. */
  onText?: (delta: string) => void;
}

/** Headers for a request, as Claude Code sends them: ANTHROPIC_API_KEY as x-api-key, ANTHROPIC_AUTH_TOKEN as Bearer. Keys are never logged. */
export function requestHeaders(backend: Backend): Record<string, string> {
  if (backend.format === "openai") {
    // OpenAI-format servers take any key as Authorization: Bearer.
    const key = backend.authToken ?? backend.apiKey;
    return { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
  }
  return {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    ...(backend.apiKey ? { "x-api-key": backend.apiKey } : {}),
    ...(backend.authToken ? { authorization: `Bearer ${backend.authToken}` } : {}),
  };
}

export class CancelledError extends ToolError {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

export async function send(deps: TransportDeps, backend: Backend, request: MessagesRequest, options: SendOptions): Promise<Message> {
  const controller = new deps.AbortController();
  let reason: "timeout" | "cancel" | undefined;
  const timer = deps.setTimeout(() => {
    reason = "timeout";
    controller.abort();
  }, options.timeoutSeconds * 1000);
  options.onCancel?.(() => {
    reason = "cancel";
    controller.abort();
  });
  const stream = Boolean(options.onText);

  try {
    const openai = backend.format === "openai";
    const response = await deps.fetch(openai ? `${backend.baseURL}/chat/completions` : `${backend.baseURL}/v1/messages`, {
      method: "POST",
      headers: requestHeaders(backend),
      body: JSON.stringify(openai ? toOpenAIRequest(request, backend.tokenParam ?? "max_tokens", stream) : { ...request, stream }),
      signal: controller.signal,
    });
    if (response.status !== 200 || !stream || !response.body) {
      return readWhole(backend, response.status, await response.text());
    }
    const accumulator = openai ? new OpenAIStreamAccumulator(options.onText) : new StreamAccumulator(options.onText);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulator.push(decoder.decode(value, { stream: true }));
    }
    accumulator.push(decoder.decode());
    return accumulator.message();
  } catch (error) {
    if (reason === "cancel") throw new CancelledError();
    if (reason === "timeout") throw new ToolError(`${backend.label} didn't answer within ${options.timeoutSeconds}s`);
    if (error instanceof ToolError) throw error;
    throw new ToolError(`Can't reach ${backend.label} at ${backend.baseURL}: ${error instanceof Error ? error.message : String(error)}. Is the proxy running?`);
  } finally {
    deps.clearTimeout(timer);
  }
}

/** A non-streamed reply, or an error reply of either kind. */
function readWhole(backend: Backend, status: number, text: string): Message {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (status !== 200) {
    const detail = errorMessage(body) ?? (typeof body === "string" ? body.slice(0, 200) : "");
    const hint = status === 401 || status === 403
      ? ` Check the key for ${backend.label} in ${backend.file}: it may be wrong, expired, or of the wrong kind (x-api-key vs Bearer).`
      : "";
    throw new ToolError(`${backend.label} returned HTTP ${status}${detail ? `: ${detail}` : ""}.${hint}`);
  }
  try {
    return backend.format === "openai" ? fromOpenAIResponse(body) : parseMessage(body);
  } catch {
    throw new ToolError(`${backend.label} sent a response that isn't a ${backend.format === "openai" ? "chat-completions" : "Messages API"} reply`);
  }
}
