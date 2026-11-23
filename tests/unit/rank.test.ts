import { describe, expect, it } from "vitest";
import { type RankFields, matchStrength, normalize, rankByScore, relevanceScore } from "../../src/zotero/rank.js";

const fields = (over: Partial<RankFields>): RankFields => ({
  title: "", creators: [], year: "", publication: [], tags: [], other: [], ...over,
});

describe("normalize", () => {
  it("ignores case and accents", () => {
    expect(normalize("Ünïcode Café")).toBe("unicode cafe");
  });
});

describe("matchStrength", () => {
  it("prefers a whole word, then a word start, then inside a word", () => {
    expect(matchStrength("kubernetes in action", "kubernetes")).toBe(2);
    expect(matchStrength("kubernetes in action", "kube")).toBe(1);
    expect(matchStrength("minikube guide", "kube")).toBe(0.5);
    expect(matchStrength("minikube guide", "helm")).toBe(0);
  });

  it("takes the best of several occurrences", () => {
    expect(matchStrength("minikube and kube", "kube")).toBe(2);
  });
});

describe("relevanceScore", () => {
  it("ranks a title match above a creator, publication or other-field match", () => {
    const title = relevanceScore(["mesh"], fields({ title: "Service Mesh Patterns" }));
    const creator = relevanceScore(["mesh"], fields({ creators: [{ lastName: "Mesh" }] }));
    const publication = relevanceScore(["mesh"], fields({ publication: ["Mesh Journal"] }));
    const other = relevanceScore(["mesh"], fields({ other: ["about mesh networks"] }));
    expect(title).toBeGreaterThan(creator);
    expect(creator).toBeGreaterThan(publication);
    expect(publication).toBeGreaterThan(other);
  });

  it("ranks the whole query in the title above the same words scattered, and an exact title highest", () => {
    const exact = relevanceScore(["site", "reliability"], fields({ title: "Site Reliability" }));
    const phrase = relevanceScore(["site", "reliability"], fields({ title: "Site Reliability Engineering" }));
    const scattered = relevanceScore(["site", "reliability"], fields({ title: "Reliability of a Site" }));
    expect(exact).toBeGreaterThan(phrase);
    expect(phrase).toBeGreaterThan(scattered);
  });

  it("scores a last-name hit above a first-name hit", () => {
    expect(relevanceScore(["jordan"], fields({ creators: [{ lastName: "Jordan", firstName: "Ann" }] })))
      .toBeGreaterThan(relevanceScore(["jordan"], fields({ creators: [{ lastName: "Smith", firstName: "Jordan" }] })));
  });

  it("gives a match seen only in full text or notes a small positive score, below any field match", () => {
    const unseen = relevanceScore(["etcd"], fields({ title: "Something else" }));
    expect(unseen).toBeGreaterThan(0);
    expect(unseen).toBeLessThan(relevanceScore(["etcd"], fields({ other: ["etcd backup"] })));
  });

  it("matches quoted phrases as one term", () => {
    expect(relevanceScore(["service mesh"], fields({ title: "A Service Mesh Primer" })))
      .toBeGreaterThan(relevanceScore(["service mesh"], fields({ title: "Mesh of Services" })));
  });
});

describe("rankByScore", () => {
  it("sorts by score, highest first, with item ID breaking ties", () => {
    expect(rankByScore([
      { id: 5, score: 1 }, { id: 2, score: 8 }, { id: 9, score: 8 }, { id: 1, score: 1 },
    ])).toEqual([2, 9, 1, 5]);
  });
});
