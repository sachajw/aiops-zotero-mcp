import { describe, expect, it } from "vitest";
import { suspender } from "../../src/zotero/suspend.js";

function pref(initial: unknown) {
  const p = { value: initial, writes: [] as unknown[] };
  const run = suspender(() => p.value, (v) => { p.value = v; p.writes.push(v); }, false);
  return { p, run };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("suspender", () => {
  it("holds the value during the call and restores it after", async () => {
    const { p, run } = pref(true);
    await run(async () => expect(p.value).toBe(false));
    expect(p.value).toBe(true);
  });

  it("restores the original after overlapping calls, whichever finishes first", async () => {
    const { p, run } = pref(true);
    const a = deferred();
    const b = deferred();
    const first = run(() => a.promise);
    const second = run(() => b.promise);
    a.resolve();
    await first;
    expect(p.value).toBe(false); // second call still inside
    b.resolve();
    await second;
    expect(p.value).toBe(true);
    expect(p.writes).toEqual([false, true]);
  });

  it("restores when the call throws", async () => {
    const { p, run } = pref(true);
    await expect(run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(p.value).toBe(true);
    await run(async () => expect(p.value).toBe(false)); // and works again afterwards
    expect(p.value).toBe(true);
  });
});
