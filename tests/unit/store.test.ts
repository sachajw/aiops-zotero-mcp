import { describe, expect, it } from "vitest";
import { MAX_VIEW_ENTRIES, parseStoredChat, serializeChat, storeFileName } from "../../src/assistant/store.js";

describe("conversation store", () => {
  it("names files only for our keys", () => {
    expect(storeFileName("library")).toBe("library.json");
    expect(storeFileName("item:1:ABCD2345")).toBe("item-1-ABCD2345.json");
    for (const bad of ["item:1:../../etc", "item:1:abcd2345", "item:x:ABCD2345", "item:1:ABCD2345/..", "other"]) expect(storeFileName(bad), bad).toBeUndefined();
  });

  it("round-trips a conversation, thinking blocks included", () => {
    const chat = {
      backend: "claude",
      messages: [
        { role: "user" as const, content: "q" },
        { role: "assistant" as const, content: [{ type: "thinking" as const, thinking: "", signature: "sig" }, { type: "text" as const, text: "a" }] },
      ],
      view: [{ role: "user" as const, text: "q" }, { role: "assistant" as const, text: "a", tools: ["Searching the library"], note: "m via claude" }],
    };
    expect(parseStoredChat(serializeChat(chat))).toEqual(chat);
  });

  it("caps what's shown, and rejects broken or foreign files", () => {
    const view = Array.from({ length: MAX_VIEW_ENTRIES + 5 }, (_, i) => ({ role: "user" as const, text: String(i) }));
    const back = parseStoredChat(serializeChat({ messages: [], view }));
    expect(back?.view).toHaveLength(MAX_VIEW_ENTRIES);
    expect(back?.view[0]).toEqual({ role: "user", text: "5" });
    expect(parseStoredChat("{")).toBeUndefined();
    expect(parseStoredChat(JSON.stringify({ version: 99, messages: [], view: [] }))).toBeUndefined();
    expect(parseStoredChat(JSON.stringify({ version: 1, messages: [{ role: "system", content: "x" }], view: [] }))).toBeUndefined();
  });
});
