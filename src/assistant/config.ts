/**
 * Which model backend the assistant talks to.
 *
 * The plugin holds no secrets: its prefs point at Claude-Code-style settings files (the JSON with an
 * "env" block of ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_*_MODEL), and the file is
 * read on every request, so a rotated token or changed model is picked up without touching Zotero.
 * Only local proxies are allowed. The parsing is pure; Zotero reads are injected.
 */
import { z } from "zod";
import { ToolError } from "../mcp/tool.js";

export const PREF_PREFIX = "extensions.aiops-zotero-mcp.llm.";
export const PROFILE_FILES_PREF = `${PREF_PREFIX}profileFiles`;
export const ACTIVE_PROFILE_PREF = `${PREF_PREFIX}activeProfile`;

export type ModelChoice = "default" | "opus" | "sonnet" | "haiku";

export interface Backend {
  /** The settings file's name without .settings.json, e.g. "zai". */
  label: string;
  file: string;
  baseURL: string;
  /** Absent when the proxy needs no credentials (e.g. a local model server). */
  token?: string;
  models: Partial<Record<ModelChoice, string>>;
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

/** Only loopback proxies: the assistant must never send library content to a remote host directly. */
export function assertLoopback(url: string, label: string): void {
  let host: string;
  let protocol: string;
  try {
    ({ hostname: host, protocol } = new URL(url));
  } catch {
    throw new ToolError(`${label}: ANTHROPIC_BASE_URL is not a valid URL (${url})`);
  }
  if (!["http:", "https:"].includes(protocol) || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
    throw new ToolError(
      `${label}: ANTHROPIC_BASE_URL must be a local proxy (127.0.0.1, localhost or [::1]), got ${url}. ` +
        "The assistant only talks to proxies on this computer.",
    );
  }
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
  assertLoopback(baseURL, label);
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
    ...(str("ANTHROPIC_AUTH_TOKEN") ? { token: str("ANTHROPIC_AUTH_TOKEN") } : {}),
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

export interface ConfigReader {
  pref(name: string): unknown;
  readFile(path: string): Promise<string>;
}

/** The selected backend, read fresh from prefs and its settings file. */
export async function loadBackend(read: ConfigReader): Promise<Backend> {
  const files = profileFiles(read.pref(PROFILE_FILES_PREF));
  if (!files.length) {
    throw new ToolError(
      `No model backend configured. Set ${PROFILE_FILES_PREF} to the absolute path of a Claude-Code-style settings file ` +
        "(one per line), e.g. /Users/you/.ccs/zai.settings.json.",
    );
  }
  const wanted = String(read.pref(ACTIVE_PROFILE_PREF) ?? "").trim();
  const file = wanted ? files.find((f) => profileLabel(f) === wanted) : files[0];
  if (!file) {
    throw new ToolError(`${ACTIVE_PROFILE_PREF} is "${wanted}", which isn't one of: ${files.map(profileLabel).join(", ")}`);
  }
  let json: string;
  try {
    json = await read.readFile(file);
  } catch {
    throw new ToolError(`${profileLabel(file)}: can't read ${file} (set in ${PROFILE_FILES_PREF})`);
  }
  return parseProfile(json, file);
}
