import { describe, expect, it } from "vitest";
import { ACTIVE_PROFILE_PREF, PROFILE_FILES_PREF, assertLoopback, modelChoice, loadBackend, parseProfile, profileFiles, profileLabel, resolveModel } from "../../src/assistant/config.js";
import { requestHeaders } from "../../src/assistant/transport.js";

const file = "/home/me/.ccs/zai.settings.json";
const env = (e: Record<string, string>) => JSON.stringify({ env: e });

describe("profile settings files", () => {
  it("names a profile after its file", () => {
    expect(profileLabel(file)).toBe("zai");
    expect(profileFiles(" /a/x.settings.json\n\n/b/y.settings.json , /c/z.json")).toEqual(["/a/x.settings.json", "/b/y.settings.json", "/c/z.json"]);
  });

  it("reads the base URL, token and model tiers", () => {
    const b = parseProfile(env({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8788/", ANTHROPIC_AUTH_TOKEN: "t0k", ANTHROPIC_MODEL: "big", ANTHROPIC_DEFAULT_HAIKU_MODEL: "small" }), file);
    expect(b).toEqual({ label: "zai", file, baseURL: "http://127.0.0.1:8788", token: "t0k", models: { default: "big", haiku: "small" } });
    expect(resolveModel(b, "haiku")).toBe("small");
    expect(resolveModel(b, "sonnet")).toBe("big");
    expect(resolveModel(b, "glm-4.7")).toBe("glm-4.7");
  });

  it("allows a profile without a token, and then sends no Authorization header", () => {
    const b = parseProfile(env({ ANTHROPIC_BASE_URL: "http://localhost:1234", ANTHROPIC_MODEL: "m" }), file);
    expect(b.token).toBeUndefined();
    expect(requestHeaders(b)).not.toHaveProperty("authorization");
    expect(requestHeaders({ ...b, token: "x" })).toMatchObject({ authorization: "Bearer x", "anthropic-version": "2023-06-01" });
  });

  it("names the missing key or broken file", () => {
    expect(() => parseProfile("{", file)).toThrow(/not valid JSON/);
    expect(() => parseProfile(env({ ANTHROPIC_MODEL: "m" }), file)).toThrow(/no env.ANTHROPIC_BASE_URL/);
    const noModel = parseProfile(env({ ANTHROPIC_BASE_URL: "http://127.0.0.1:1" }), file);
    expect(() => resolveModel(noModel, "default")).toThrow(/no env.ANTHROPIC_MODEL/);
  });

  it("only allows local proxies", () => {
    for (const ok of ["http://127.0.0.1:8787", "http://localhost:1234", "https://localhost", "http://[::1]:8080"]) {
      expect(() => assertLoopback(ok, "x"), ok).not.toThrow();
    }
    for (const bad of ["http://192.168.0.9:1234", "https://integrate.api.nvidia.com", "file:///etc/passwd", "http://127.0.0.1.evil.com", "nonsense"]) {
      expect(() => assertLoopback(bad, "x"), bad).toThrow();
    }
  });
});

describe("loadBackend", () => {
  const files = { "/a/zai.settings.json": env({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8788", ANTHROPIC_MODEL: "glm" }), "/a/claude.settings.json": env({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8787", ANTHROPIC_MODEL: "c" }) } as Record<string, string>;
  const reader = (prefs: Record<string, string>) => ({
    pref: (n: string) => prefs[n],
    readFile: async (p: string) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
  });

  it("uses the active profile, or the first one", async () => {
    const both = "/a/zai.settings.json\n/a/claude.settings.json";
    expect((await loadBackend(reader({ [PROFILE_FILES_PREF]: both }))).label).toBe("zai");
    expect((await loadBackend(reader({ [PROFILE_FILES_PREF]: both, [ACTIVE_PROFILE_PREF]: "claude" }))).label).toBe("claude");
  });

  it("explains what to set when nothing or the wrong thing is configured", async () => {
    await expect(loadBackend(reader({}))).rejects.toThrow(/No model backend configured/);
    await expect(loadBackend(reader({ [PROFILE_FILES_PREF]: "/a/zai.settings.json", [ACTIVE_PROFILE_PREF]: "nope" }))).rejects.toThrow(/isn't one of: zai/);
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
