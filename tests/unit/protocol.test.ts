import { describe, expect, it } from "vitest";
import { classifyMessage, negotiateProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS } from "../../src/mcp/protocol.js";

describe("classifyMessage", () => {
  it("recognises a request", () => {
    const m = classifyMessage({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    expect(m).toEqual({ kind: "request", message: { jsonrpc: "2.0", id: 7, method: "tools/list" } });
  });

  it("recognises a notification (no id)", () => {
    expect(classifyMessage({ jsonrpc: "2.0", method: "notifications/initialized" }).kind).toBe("notification");
  });

  it("recognises a response", () => {
    expect(classifyMessage({ jsonrpc: "2.0", id: 1, result: {} }).kind).toBe("response");
  });

  it.each([
    ["an array (batch)", [{ jsonrpc: "2.0", id: 1, method: "ping" }]],
    ["a string", "ping"],
    ["null", null],
    ["wrong jsonrpc", { jsonrpc: "1.0", id: 1, method: "ping" }],
    ["object id", { jsonrpc: "2.0", id: {}, method: "ping" }],
    ["missing method", { jsonrpc: "2.0", id: 1 }],
    ["array params", { jsonrpc: "2.0", id: 1, method: "ping", params: [] }],
  ])("rejects %s", (_label, body) => {
    const m = classifyMessage(body);
    expect(m.kind).toBe("invalid");
    if (m.kind === "invalid") expect(m.error.error.code).toBe(-32600);
  });

  it("keeps the id on an invalid request when it has one", () => {
    const m = classifyMessage({ jsonrpc: "2.0", id: 9 });
    expect(m.kind === "invalid" && m.error.id).toBe(9);
  });
});

describe("negotiateProtocolVersion", () => {
  it("echoes a supported version", () => {
    expect(negotiateProtocolVersion("2025-06-18")).toBe("2025-06-18");
  });

  it("offers the newest for an unknown or missing version", () => {
    expect(negotiateProtocolVersion("1999-01-01")).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(negotiateProtocolVersion(undefined)).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });
});
