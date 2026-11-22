import { describe, expect, it } from "vitest";
import { count, nextPage, zKey } from "../../src/zotero/library.js";

describe("count", () => {
  it("uses the singular for one and the plural otherwise", () => {
    expect(count(1, "item")).toBe("1 item");
    expect(count(0, "item")).toBe("0 items");
    expect(count(3, "library", "libraries")).toBe("3 libraries");
  });
});

describe("zKey", () => {
  it("accepts Zotero keys and rejects anything else", () => {
    expect(zKey.safeParse("ABCD2345").success).toBe(true);
    for (const bad of ["abcd2345", "ABCD234", "ABCD23450", "ABCD0345", "ABCD1345", "ABCDO345"]) {
      expect(zKey.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("nextPage", () => {
  it("gives the next offset while entries remain, and null at the end", () => {
    expect(nextPage(0, 25, 60)).toEqual({ hasMore: true, nextOffset: 25 });
    expect(nextPage(50, 10, 60)).toEqual({ hasMore: false, nextOffset: null });
    expect(nextPage(100, 0, 60)).toEqual({ hasMore: false, nextOffset: null });
  });
});
