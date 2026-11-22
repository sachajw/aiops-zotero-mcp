/**
 * Which model backend the assistant talks to. Two kinds, listed together:
 *
 * - **Settings files**: prefs point at Claude-Code-style settings files (an "env" block of
 *   ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, ANTHROPIC_*_MODEL), read on
 *   every request, so a rotated key or changed model applies without touching Zotero. Suits a
 *   local proxy or anyone who already has these files for Claude Code.
 * - **Providers added in Settings**: a name, base URL, key type and models in a pref; the key
 *   itself in Zotero's password store (zotero.ts), never in prefs.
 *
 * Keys only travel encrypted: plain http is allowed to this computer only, https anywhere.
 * The parsing is pure; Zotero reads are injected.
 */
import { z } from "zod";
import { ToolError } from "../mcp/tool.js";

export const PREF_PREFIX = "extensions.aiops-zotero-mcp.llm.";
export const PROFILE_FILES_PREF = `${PREF_PREFIX}profileFiles`;
export const ACTIVE_PROFILE_PREF = `${PREF_PREFIX}activeProfile`;
export const BACKENDS_PREF = `${PREF_PREFIX}backends`;
export const SETTINGS_SOURCE = "Zotero Settings → Zotero MCP Assistant";

export type ModelChoice = "default" | "opus" | "sonnet" | "haiku";
/** How the key is sent: x-api-key (Anthropic API keys) or Authorization: Bearer (tokens, OpenAI-format servers). */
export type AuthKind = "x-api-key" | "bearer";
/** The API a backend speaks: Anthropic Messages (/v1/messages) or OpenAI chat completions (/chat/completions). */
export type ApiFormat = "anthropic" | "openai";
export type TokenParam = "max_completion_tokens" | "max_tokens";

export interface Backend {
  /** The settings file's name without .settings.json (e.g. "zai"), or the name given in Settings. */
  label: string;
  /** Where it's configured: the file path, or SETTINGS_SOURCE. */
  file: string;
  baseURL: string;
  /** Sent as x-api-key (ANTHROPIC_API_KEY). */
  apiKey?: string;
  /** Sent as Authorization: Bearer (ANTHROPIC_AUTH_TOKEN). */
  authToken?: string;
  models: Partial<Record<ModelChoice, string>>;
  /** Absent means "anthropic" (settings files are always Anthropic format). */
  format?: ApiFormat;
  /** OpenAI format only: the field for the reply cap. */
  tokenParam?: TokenParam;
}

/** "/path/to/zai.settings.json" → "zai". */
export function profileLabel(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? file;
  return name.replace(/\.settings\.json$/, "").replace(/\.json$/, "");
}

/** The pref's newline- or comma-separated list of absolute paths. */
export function profileFiles(raw: unknown): string[] {
  return String(raw ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]", "::1"];

/**
 * A base URL keys may be sent to: https to any host, or plain http to this computer only (a local
 * proxy or model server). A key must never cross a network unencrypted.
 */
export function isLoopback(url: string): boolean {
  try {
    return LOOPBACK.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function assertBaseURL(url: string, label: string): void {
  let host: string;
  let protocol: string;
  try {
    ({ hostname: host, protocol } = new URL(url));
  } catch {
    throw new ToolError(`${label}: the base URL isn't a valid URL (${url})`);
  }
  if (protocol === "https:") return;
  if (protocol === "http:" && LOOPBACK.includes(host)) return;
  throw new ToolError(
    `${label}: the base URL must use https, or plain http only to this computer (127.0.0.1, localhost, [::1]); got ${url}`,
  );
}

const zSettings = z.object({ env: z.record(z.string(), z.unknown()).optional() });

/** Parse one settings file's contents. Throws ToolError naming the file and key that's wrong. */
export function parseProfile(json: string, file: string): Backend {
  const label = profileLabel(file);
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ToolError(`${label}: ${file} is not valid JSON`);
  }
  const parsed = zSettings.safeParse(data);
  const env = parsed.success ? (parsed.data.env ?? {}) : {};
  const str = (key: string) => (typeof env[key] === "string" && (env[key] as string).trim() ? (env[key] as string).trim() : undefined);

  const baseURL = str("ANTHROPIC_BASE_URL");
  if (!baseURL) throw new ToolError(`${label}: ${file} has no env.ANTHROPIC_BASE_URL`);
  assertBaseURL(baseURL, label);
  const models = {
    default: str("ANTHROPIC_MODEL"),
    opus: str("ANTHROPIC_DEFAULT_OPUS_MODEL"),
    sonnet: str("ANTHROPIC_DEFAULT_SONNET_MODEL"),
    haiku: str("ANTHROPIC_DEFAULT_HAIKU_MODEL"),
  };
  return {
    label,
    file,
    baseURL: baseURL.replace(/\/+$/, ""),
    ...(str("ANTHROPIC_API_KEY") ? { apiKey: str("ANTHROPIC_API_KEY") } : {}),
    ...(str("ANTHROPIC_AUTH_TOKEN") ? { authToken: str("ANTHROPIC_AUTH_TOKEN") } : {}),
    models: Object.fromEntries(Object.entries(models).filter(([, v]) => v)) as Backend["models"],
  };
}

/**
 * The model ID for a choice: a tier name ("haiku") resolves through the profile, falling back to the
 * profile's default model; anything else is taken as a literal model ID.
 */
export function resolveModel(backend: Backend, choice: string): string {
  const tier = choice.trim() || "default";
  if (["default", "opus", "sonnet", "haiku"].includes(tier)) {
    const model = backend.models[tier as ModelChoice] ?? backend.models.default;
    if (!model) throw new ToolError(`${backend.label}: ${backend.file} has no env.ANTHROPIC_MODEL (needed for "${tier}")`);
    return model;
  }
  return tier;
}

export type ModelUse = "chatModel" | "actionModel";

/**
 * The model choice for a use on a backend: the backend's own pref (llm.chatModel.zai) if set,
 * else the shared one (llm.chatModel), else the default. Tiers mean different models per backend,
 * so a per-backend setting lets e.g. Z.ai use its top model while Claude stays on a smaller one.
 */
export function modelChoice(pref: (name: string) => unknown, use: ModelUse, label: string, fallback: string): string {
  for (const name of [`${PREF_PREFIX}${use}.${label}`, `${PREF_PREFIX}${use}`]) {
    const v = pref(name);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return fallback;
}

// ------------------------------------------------------- providers in Settings

/** A provider added in Settings. The key isn't part of it: it lives in Zotero's password store. */
export interface StoredBackend {
  name: string;
  baseURL: string;
  auth: AuthKind;
  models: Partial<Record<ModelChoice, string>> & { default: string };
  format?: ApiFormat;
  tokenParam?: TokenParam;
}

const zModel = z.string().trim().min(1).max(200);
/** An optional tier: an empty form field means "not set". */
const zOptionalModel = z.preprocess((v) => (typeof v === "string" && !v.trim() ? undefined : v), zModel.optional());
const zStoredBackend = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "lowercase letters, digits and hyphens, up to 32 characters"),
  baseURL: z.string().trim().url(),
  auth: z.enum(["x-api-key", "bearer"]),
  models: z.object({ default: zModel, opus: zOptionalModel, sonnet: zOptionalModel, haiku: zOptionalModel }),
  format: z.enum(["anthropic", "openai"]).optional(),
  tokenParam: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
});

/** Starting points for the Settings form; every field stays editable. */
export const PROVIDERS: Record<string, Omit<StoredBackend, "name" | "models"> & { title: string; models: Record<string, string> }> = {
  anthropic: {
    title: "Anthropic (Claude API key)",
    baseURL: "https://api.anthropic.com",
    auth: "x-api-key",
    models: { default: "claude-sonnet-5-5", opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" },
  },
  openai: {
    title: "OpenAI (API key; OpenAI format)",
    baseURL: "https://api.openai.com/v1",
    auth: "bearer",
    format: "openai",
    tokenParam: "max_completion_tokens",
    models: { default: "" },
  },
  openrouter: {
    title: "OpenRouter (API key; OpenAI format)",
    baseURL: "https://openrouter.ai/api/v1",
    auth: "bearer",
    format: "openai",
    tokenParam: "max_tokens",
    models: { default: "" },
  },
  ollama: {
    title: "Ollama on this computer (no key; OpenAI format)",
    baseURL: "http://127.0.0.1:11434/v1",
    auth: "bearer",
    format: "openai",
    tokenParam: "max_tokens",
    models: { default: "" },
  },
  lmstudio: {
    title: "LM Studio on this computer (no key; OpenAI format)",
    baseURL: "http://127.0.0.1:1234/v1",
    auth: "bearer",
    format: "openai",
    tokenParam: "max_tokens",
    models: { default: "" },
  },
  gateway: {
    title: "Local gateway or proxy on this computer (key optional)",
    baseURL: "http://127.0.0.1:8080",
    auth: "bearer",
    models: { default: "" },
  },
  zai: {
    title: "Z.ai (GLM API key)",
    baseURL: "https://api.z.ai/api/anthropic",
    auth: "bearer",
    models: { default: "glm-5.3", opus: "glm-5.3", sonnet: "glm-5.3", haiku: "glm-4.5-air" },
  },
};

/** The providers saved in Settings (the pref's JSON); entries that don't validate are skipped. */
export function parseStoredBackends(raw: unknown): StoredBackend[] {
  let data: unknown;
  try {
    data = JSON.parse(String(raw ?? "") || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.flatMap((d) => {
    const parsed = zStoredBackend.safeParse(d);
    return parsed.success ? [parsed.data as StoredBackend] : [];
  });
}

/** Check a provider from the Settings form before it's saved. Throws ToolError saying what's wrong. */
export function validateStoredBackend(input: unknown, takenLabels: string[]): StoredBackend {
  const parsed = zStoredBackend.safeParse(input);
  if (!parsed.success) throw new ToolError(z.prettifyError(parsed.error));
  const def = parsed.data as StoredBackend;
  if (takenLabels.includes(def.name)) throw new ToolError(`"${def.name}" is already the name of a backend; pick another`);
  assertBaseURL(def.baseURL, def.name);
  const models = Object.fromEntries(Object.entries(def.models).filter(([, v]) => v)) as StoredBackend["models"];
  return { ...def, baseURL: def.baseURL.replace(/\/+$/, ""), models };
}

export function backendFromStored(def: StoredBackend, key: string | undefined): Backend {
  assertBaseURL(def.baseURL, def.name);
  // A gateway on this computer may sign in by itself; anywhere else a key is required.
  if (!key && !isLoopback(def.baseURL)) throw new ToolError(`${def.name}: no API key is saved for it. Add it again in ${SETTINGS_SOURCE}.`);
  return {
    label: def.name,
    file: SETTINGS_SOURCE,
    baseURL: def.baseURL.replace(/\/+$/, ""),
    ...(key ? (def.auth === "x-api-key" ? { apiKey: key } : { authToken: key }) : {}),
    models: def.models,
    ...(def.format === "openai" ? { format: "openai" as const, tokenParam: def.tokenParam ?? "max_tokens" } : {}),
  };
}

/** Every backend's label: settings files first, then providers added in Settings. */
export function backendLabels(filesPref: unknown, backendsPref: unknown): string[] {
  return [...profileFiles(filesPref).map(profileLabel), ...parseStoredBackends(backendsPref).map((b) => b.name)];
}

export interface ConfigReader {
  pref(name: string): unknown;
  readFile(path: string): Promise<string>;
  /** The key saved for a provider added in Settings. */
  readKey(name: string): Promise<string | undefined>;
}

/** A backend, read fresh: the one named, else the active one, else the first. */
export async function loadBackend(read: ConfigReader, name?: string): Promise<Backend> {
  const files = profileFiles(read.pref(PROFILE_FILES_PREF));
  const stored = parseStoredBackends(read.pref(BACKENDS_PREF));
  const labels = [...files.map(profileLabel), ...stored.map((b) => b.name)];
  if (!labels.length) {
    throw new ToolError(
      `No model backend set up. Add a provider and its API key in ${SETTINGS_SOURCE}, or set ${PROFILE_FILES_PREF} ` +
        "to the absolute path of a Claude-Code-style settings file.",
    );
  }
  const wanted = (name ?? String(read.pref(ACTIVE_PROFILE_PREF) ?? "")).trim() || labels[0];
  const file = files.find((f) => profileLabel(f) === wanted);
  if (file) {
    let json: string;
    try {
      json = await read.readFile(file);
    } catch {
      throw new ToolError(`${wanted}: can't read ${file} (set in ${PROFILE_FILES_PREF})`);
    }
    return parseProfile(json, file);
  }
  const def = stored.find((b) => b.name === wanted);
  if (def) return backendFromStored(def, await read.readKey(def.name));
  throw new ToolError(`The backend "${wanted}" isn't set up; set up ones are: ${labels.join(", ")}`);
}
