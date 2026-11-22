/**
 * Saved conversations: what's written to disk and read back, validated on the way in. One file per
 * conversation, named from its key. Pure; the file access is in ui/chat.ts via assistant/zotero.ts.
 */
import { z } from "zod";
import type { MessageParam } from "./anthropic.js";

export const STORE_VERSION = 1;
/** Older entries beyond this are dropped from what's shown (the model's history is trimmed separately). */
export const MAX_VIEW_ENTRIES = 200;

export type ViewEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; tools: string[]; note?: string; error?: boolean };

export interface StoredChat {
  backend?: string;
  messages: MessageParam[];
  view: ViewEntry[];
}

const zView = z.union([
  z.object({ role: z.literal("user"), text: z.string() }),
  z.object({ role: z.literal("assistant"), text: z.string(), tools: z.array(z.string()), note: z.string().optional(), error: z.boolean().optional() }),
]);

const zMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()).and(z.object({ type: z.string() })))]),
});

const zStored = z.object({
  version: z.literal(STORE_VERSION),
  backend: z.string().optional(),
  messages: z.array(zMessage),
  view: z.array(zView),
});

/**
 * The file name for a conversation key, or undefined for a key that isn't one of ours (so a
 * malformed key can never name a path outside the chats folder).
 */
export function storeFileName(key: string): string | undefined {
  if (key === "library") return "library.json";
  const m = /^item:(\d+):([23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8})$/.exec(key);
  return m ? `item-${m[1]}-${m[2]}.json` : undefined;
}

export function serializeChat(chat: StoredChat): string {
  return JSON.stringify({
    version: STORE_VERSION,
    ...(chat.backend ? { backend: chat.backend } : {}),
    messages: chat.messages,
    view: chat.view.slice(-MAX_VIEW_ENTRIES),
  });
}

/** The saved conversation, or undefined if the file is unreadable, invalid or from another version. */
export function parseStoredChat(json: string): StoredChat | undefined {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return undefined;
  }
  const parsed = zStored.safeParse(data);
  if (!parsed.success) return undefined;
  const { backend, messages, view } = parsed.data;
  return { ...(backend ? { backend } : {}), messages: messages as MessageParam[], view };
}

/** Conversation keys for items Zotero reports as deleted (Notifier "delete" extraData). */
export function deletedChatKeys(ids: number[], extraData: Record<string, unknown>): string[] {
  return ids.flatMap((id) => {
    const d = extraData[String(id)] as { libraryID?: unknown; key?: unknown } | undefined;
    return typeof d?.libraryID === "number" && typeof d.key === "string" ? [`item:${d.libraryID}:${d.key}`] : [];
  });
}
