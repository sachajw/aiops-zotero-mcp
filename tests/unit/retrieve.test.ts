import { describe, expect, it } from "vitest";
import { parseWaitSeconds } from "../../src/tools/write.js";

describe("parseWaitSeconds", () => {
  it("accepts a whole number of seconds", () => {
    expect(parseWaitSeconds(45)).toBe(45);
    expect(parseWaitSeconds("30")).toBe(30);
  });

  it("refuses anything else, naming the pref", () => {
    for (const bad of [0, -5, 1.5, "abc", "", undefined, null]) {
      expect(() => parseWaitSeconds(bad), String(bad)).toThrow(/retrieveMetadataWaitSeconds/);
    }
  });
});
