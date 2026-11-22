import { describe, expect, it } from "vitest";
import { parseWaitSeconds, unfinishedOutcome } from "../../src/tools/write.js";

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

describe("unfinishedOutcome", () => {
  const done = { status: 3, message: "No matching references found" };

  it("reports a finished row as not recognized, with Zotero's message", () => {
    expect(unfinishedOutcome(done, undefined)).toEqual({ status: "not_recognized", reason: "No matching references found" });
    expect(unfinishedOutcome({ status: 3, message: "" }, undefined).reason).toBe("no match found");
  });

  it("reports a queued, processing or missing row as pending while the run is alive", () => {
    for (const row of [{ status: 1 }, { status: 2 }, undefined]) {
      expect(unfinishedOutcome(row, undefined).status, JSON.stringify(row)).toBe("pending");
    }
  });

  it("reports unfinished rows as failed, with the error, once the run has failed", () => {
    const failure = { error: new Error("PDF worker crashed") };
    expect(unfinishedOutcome({ status: 2 }, failure)).toMatchObject({ status: "failed", reason: expect.stringContaining("PDF worker crashed") });
    expect(unfinishedOutcome(undefined, { error: undefined }).status).toBe("failed");
    expect(unfinishedOutcome(done, failure).status).toBe("not_recognized");
  });
});
