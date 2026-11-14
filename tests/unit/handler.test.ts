import { describe, expect, it } from "vitest";
import { constantTimeEqual, handleHttp, type HttpRequest } from "../../src/http/handler.js";
import { McpServer } from "../../src/mcp/server.js";

const TOKEN = "s3cret-token-value";
const server = new McpServer({ info: { name: "t", title: "T", version: "1" }, tools: [] });
const options = { server, token: () => TOKEN };

function req(over: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...over.headers },
    body: { jsonrpc: "2.0", id: 1, method: "ping" },
    ...("body" in over ? { body: over.body } : {}),
    ...(over.method ? { method: over.method } : {}),
  };
}

describe("handleHttp", () => {
  it("answers a request with 200 JSON", async () => {
    const res = await handleHttp(req(), options);
    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("accepts a notification with 202 and no body", async () => {
    const res = await handleHttp(req({ body: { jsonrpc: "2.0", method: "notifications/initialized" } }), options);
    expect(res).toEqual({ status: 202, headers: {}, body: "" });
  });

  it("accepts a response with 202", async () => {
    expect((await handleHttp(req({ body: { jsonrpc: "2.0", id: 3, result: {} } }), options)).status).toBe(202);
  });

  it("refuses any request with an Origin header (DNS rebinding)", async () => {
    const res = await handleHttp(req({ headers: { origin: "http://evil.example" } }), options);
    expect(res.status).toBe(403);
  });

  it("refuses a missing token", async () => {
    const res = await handleHttp(req({ headers: { authorization: undefined } }), options);
    expect(res.status).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toMatch(/^Bearer/);
  });

  it("refuses a wrong token, including a prefix of the right one", async () => {
    expect((await handleHttp(req({ headers: { authorization: "Bearer nope" } }), options)).status).toBe(401);
    expect((await handleHttp(req({ headers: { authorization: `Bearer ${TOKEN.slice(0, -1)}` } }), options)).status).toBe(401);
    expect((await handleHttp(req({ headers: { authorization: TOKEN } }), options)).status).toBe(401);
  });

  it("refuses everything with 503 while no token is configured", async () => {
    expect((await handleHttp(req(), { server, token: () => "" })).status).toBe(503);
    expect((await handleHttp(req(), { server, token: () => undefined })).status).toBe(503);
  });

  it("checks auth before revealing anything about methods", async () => {
    expect((await handleHttp(req({ method: "GET", headers: { authorization: undefined } }), options)).status).toBe(401);
  });

  it("returns 405 for GET (no SSE stream offered)", async () => {
    const res = await handleHttp(req({ method: "GET" }), options);
    expect(res.status).toBe(405);
    expect(res.headers.Allow).toBe("POST");
  });

  it("rejects an unsupported MCP-Protocol-Version header with 400", async () => {
    expect((await handleHttp(req({ headers: { "mcp-protocol-version": "2020-01-01" } }), options)).status).toBe(400);
    expect((await handleHttp(req({ headers: { "mcp-protocol-version": "2025-06-18" } }), options)).status).toBe(200);
  });

  it("rejects an invalid JSON-RPC body with 400 and a JSON-RPC error", async () => {
    const res = await handleHttp(req({ body: [1, 2] }), options);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(-32600);
  });
});

describe("constantTimeEqual", () => {
  it("compares exactly", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
    expect(constantTimeEqual("", "a")).toBe(false);
  });
});
