import { describe, expect, it } from "vitest";
import { ACTIVE_PROFILE_PREF, PROFILE_FILES_PREF, assertBaseURL, modelChoice, loadBackend, parseProfile, profileFiles, profileLabel, resolveModel } from "../../src/assistant/config.js";
import { requestHeaders } from "../../src/assistant/transport.js";

const file = "/home/me/.ccs/zai.settings.json";
const env = (e: Record<string, string>) => JSON.stringify({ env: e });

describe("profile settings files", () => {
  it("names a profile after its file", () => {
    expect(profileLabel(file)).toBe("zai");
    expect(profileFiles(" /a/x.settings.json\n\n/b/y.settings.json , /c/z.json")).toEqual(["/a/x.settings.json", "/b/y.settings.json", "/c/z.json"]);
  });

  it("reads the base URL, both kinds of key and the model tiers", () => {
    const b = parseProfile(env({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8788/", ANTHROPIC_AUTH_TOKEN: "t0k", ANTHROPIC_MODEL: "big", ANTHROPIC_DEFAULT_HAIKU_MODEL: "small" }), file);
    expect(b).toEqual({ label: "zai", file, baseURL: "http://127.0.0.1:8788", authToken: "t0k", models: { default: "big", haiku: "small" } });
    expect(parseProfile(env({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "sk", ANTHROPIC_MODEL: "m" }), file)).toMatchObject({ apiKey: "sk" });
    expect(resolveModel(b, "haiku")).toBe("small");
    expect(resolveModel(b, "sonnet")).toBe("big");
    expect(resolveModel(b, "glm-4.7")).toBe("glm-4.7");
  });

  it("allows a profile without a token, and then sends no Authorization header", () => {
    const b = parseProfile(env({ ANTHROPIC_BASE_URL: "http://localhost:1234", ANTHROPIC_MODEL: "m" }), file);
    expect(b.authToken).toBeUndefined();
    expect(requestHeaders(b)).not.toHaveProperty("authorization");
    expect(requestHeaders({ ...b, authToken: "x" })).toMatchObject({ authorization: "Bearer x", "anthropic-version": "2023-06-01" });
    expect(requestHeaders({ ...b, apiKey: "k" })).toMatchObject({ "x-api-key": "k" });
    expect(requestHeaders({ ...b, apiKey: "k" })).not.toHaveProperty("authorization");
  });

  it("names the missing key or broken file", () => {
    expect(() => parseProfile("{", file)).toThrow(/not valid JSON/);
    expect(() => parseProfile(env({ ANTHROPIC_MODEL: "m" }), file)).toThrow(/no env.ANTHROPIC_BASE_URL/);
    const noModel = parseProfile(env({ ANTHROPIC_BASE_URL: "http://127.0.0.1:1" }), file);
    expect(() => resolveModel(noModel, "default")).toThrow(/no env.ANTHROPIC_MODEL/);
  });

  it("sends keys only over https, or plain http to this computer", () => {
    for (const ok of ["http://127.0.0.1:8787", "http://localhost:1234", "https://localhost", "http://[::1]:8080", "https://api.anthropic.com", "https://api.z.ai/api/anthropic"]) {
      expect(() => assertBaseURL(ok, "x"), ok).not.toThrow();
    }
    for (const bad of ["http://192.168.0.9:1234", "http://api.anthropic.com", "file:///etc/passwd", "http://127.0.0.1.evil.com", "ftp://localhost", "nonsense"]) {
      expect(() => assertBaseURL(bad, "x"), bad).toThrow();
    }
  });
});

describe("loadBackend", () => {
  const files = { "/a/zai.settings.json": env({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8788", ANTHROPIC_MODEL: "glm" }), "/a/claude.settings.json": env({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8787", ANTHROPIC_MODEL: "c" }) } as Record<string, string>;
  const keys: Record<string, string> = { anthropic: "sk-ant" };
  const reader = (prefs: Record<string, string>) => ({
    pref: (n: string) => prefs[n],
    readFile: async (p: string) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
    readKey: async (n: string) => keys[n],
  });

  it("uses the active profile, or the first one", async () => {
    const both = "/a/zai.settings.json\n/a/claude.settings.json";
    expect((await loadBackend(reader({ [PROFILE_FILES_PREF]: both }))).label).toBe("zai");
    expect((await loadBackend(reader({ [PROFILE_FILES_PREF]: both, [ACTIVE_PROFILE_PREF]: "claude" }))).label).toBe("claude");
  });

  it("explains what to set when nothing or the wrong thing is configured", async () => {
    await expect(loadBackend(reader({}))).rejects.toThrow(/No model backend set up/);
    await expect(loadBackend(reader({ [PROFILE_FILES_PREF]: "/a/zai.settings.json", [ACTIVE_PROFILE_PREF]: "nope" }))).rejects.toThrow(/set up ones are: zai/);
    await expect(loadBackend(reader({ [PROFILE_FILES_PREF]: "/a/missing.settings.json" }))).rejects.toThrow(/can't read/);
  });
});

describe("modelChoice", () => {
  const P = "extensions.aiops-zotero-mcp.llm.";
  it("prefers the backend's own setting, then the shared one, then the default", () => {
    const prefs: Record<string, string> = { [`${P}chatModel`]: "sonnet", [`${P}chatModel.zai`]: "default", [`${P}chatModel.claude`]: "  " };
    const pref = (n: string) => prefs[n];
    expect(modelChoice(pref, "chatModel", "zai", "x")).toBe("default");
    expect(modelChoice(pref, "chatModel", "claude", "x")).toBe("sonnet");
    expect(modelChoice(() => undefined, "actionModel", "zai", "haiku")).toBe("haiku");
  });
});

import { BACKENDS_PREF, PROVIDERS, backendLabels, parseStoredBackends, validateStoredBackend } from "../../src/assistant/config.js";

describe("providers added in Settings", () => {
  const anthropic = { name: "anthropic", ...PROVIDERS.anthropic };
  const zaiStored = { name: "zai-direct", baseURL: "https://api.z.ai/api/anthropic/", auth: "bearer", models: { default: "glm-5.3", haiku: "" } };

  it("validates the form, trims the URL, drops empty models and refuses a taken name or plain http", () => {
    expect(validateStoredBackend(zaiStored, [])).toEqual({ name: "zai-direct", baseURL: "https://api.z.ai/api/anthropic", auth: "bearer", models: { default: "glm-5.3" } });
    expect(() => validateStoredBackend(zaiStored, ["zai-direct"])).toThrow(/already the name/);
    expect(() => validateStoredBackend({ ...zaiStored, baseURL: "http://example.com" }, [])).toThrow(/https/);
    expect(() => validateStoredBackend({ ...zaiStored, name: "Bad Name" }, [])).toThrow();
    expect(() => validateStoredBackend({ ...zaiStored, models: {} }, [])).toThrow();
  });

  it("skips invalid saved entries and lists files before providers", () => {
    const pref = JSON.stringify([anthropic, { name: "broken" }]);
    expect(parseStoredBackends(pref).map((b) => b.name)).toEqual(["anthropic"]);
    expect(parseStoredBackends("not json")).toEqual([]);
    expect(backendLabels("/a/zai.settings.json", pref)).toEqual(["zai", "anthropic"]);
  });

  it("loads a provider with its key from the password store, sent as the right header", async () => {
    const prefs = { [BACKENDS_PREF]: JSON.stringify([anthropic, { ...zaiStored, baseURL: "https://api.z.ai/api/anthropic" }]), [ACTIVE_PROFILE_PREF]: "anthropic" };
    const read = { pref: (n: string) => (prefs as Record<string, string>)[n], readFile: async () => "", readKey: async (n: string) => (n === "anthropic" ? "sk-ant" : undefined) };
    const b = await loadBackend(read);
    expect(b).toMatchObject({ label: "anthropic", baseURL: "https://api.anthropic.com", apiKey: "sk-ant" });
    expect(requestHeaders(b)).toMatchObject({ "x-api-key": "sk-ant" });
    await expect(loadBackend(read, "zai-direct")).rejects.toThrow(/no API key is saved/);
  });
});

describe("gateways on this computer", () => {
  it("can be added and used without a key; a remote provider can't", async () => {
    const gw = { name: "gw", baseURL: "http://127.0.0.1:8787", auth: "bearer" as const, models: { default: "claude-sonnet-5-5" } };
    const read = (backends: unknown[]) => ({ pref: (n: string) => (n === BACKENDS_PREF ? JSON.stringify(backends) : undefined), readFile: async () => "", readKey: async () => undefined });
    const b = await loadBackend(read([gw]));
    expect(b).toMatchObject({ label: "gw", baseURL: "http://127.0.0.1:8787" });
    expect(requestHeaders(b)).not.toHaveProperty("authorization");
    expect(requestHeaders(b)).not.toHaveProperty("x-api-key");
    await expect(loadBackend(read([{ ...gw, baseURL: "https://api.example.com" }]))).rejects.toThrow(/no API key/);
    expect(PROVIDERS.gateway.baseURL).toMatch(/^http:\/\/127\.0\.0\.1/);
  });
});

describe("OpenAI-format providers", () => {
  it("load with their format and token field, and send the key as Bearer", async () => {
    const def = { name: "ollama", baseURL: "http://127.0.0.1:11434/v1", auth: "bearer", format: "openai", tokenParam: "max_tokens", models: { default: "llama3.2" } };
    const read = { pref: (n: string) => (n === BACKENDS_PREF ? JSON.stringify([def]) : undefined), readFile: async () => "", readKey: async () => undefined };
    const b = await loadBackend(read);
    expect(b).toMatchObject({ format: "openai", tokenParam: "max_tokens" });
    expect(requestHeaders(b)).toEqual({ "content-type": "application/json" });
    expect(requestHeaders({ ...b, apiKey: "sk" })).toEqual({ "content-type": "application/json", authorization: "Bearer sk" });
    expect(PROVIDERS.openai).toMatchObject({ format: "openai", tokenParam: "max_completion_tokens", baseURL: "https://api.openai.com/v1" });
  });
});
