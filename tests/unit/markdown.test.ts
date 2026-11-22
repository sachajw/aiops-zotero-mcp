import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../../src/assistant/markdown.js";

describe("parseInline", () => {
  it("handles bold, italic, code and links", () => {
    expect(parseInline("A **bold** and *em* and `x*y` [site](https://ex.com) end")).toEqual([
      { type: "text", text: "A " },
      { type: "strong", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: " and " },
      { type: "em", children: [{ type: "text", text: "em" }] },
      { type: "text", text: " and " },
      { type: "code", text: "x*y" },
      { type: "text", text: " " },
      { type: "link", href: "https://ex.com", children: [{ type: "text", text: "site" }] },
      { type: "text", text: " end" },
    ]);
  });

  it("nests emphasis inside bold, links bare URLs without trailing punctuation", () => {
    expect(parseInline("**the *Sidecar* pattern**")).toEqual([
      { type: "strong", children: [{ type: "text", text: "the " }, { type: "em", children: [{ type: "text", text: "Sidecar" }] }, { type: "text", text: " pattern" }] },
    ]);
    expect(parseInline("See https://zotero.org/support.")).toEqual([
      { type: "text", text: "See " },
      { type: "link", href: "https://zotero.org/support", children: [{ type: "text", text: "https://zotero.org/support" }] },
      { type: "text", text: "." },
    ]);
  });

  it("leaves unclosed markers, snake_case and arithmetic as text", () => {
    expect(parseInline("**still streaming")).toEqual([{ type: "text", text: "**still streaming" }]);
    expect(parseInline("call zotero_get_fulltext and 2 * 3 * 4")).toEqual([{ type: "text", text: "call zotero_get_fulltext and 2 * 3 * 4" }]);
  });

  it("keeps line breaks and never produces markup", () => {
    expect(parseInline("a\nb")).toEqual([{ type: "text", text: "a" }, { type: "break" }, { type: "text", text: "b" }]);
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([{ type: "text", text: "<img src=x onerror=alert(1)>" }]);
  });
});

describe("parseMarkdown", () => {
  it("parses the block types models write", () => {
    const md = [
      "# Title",
      "",
      "Para line one",
      "line two.",
      "",
      "- one",
      "- two",
      "  - nested",
      "",
      "1. first",
      "2. second",
      "",
      "```js",
      "const a = '**not bold**';",
      "```",
      "",
      "> quoted",
      "",
      "---",
      "",
      "| Key | Title |",
      "|-----|-------|",
      "| `ABCD2345` | **Book** |",
    ].join("\n");
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "list", "code", "quote", "rule", "table"]);
    expect(blocks[2]).toMatchObject({ type: "list", ordered: false, items: [{ depth: 0 }, { depth: 0 }, { depth: 1 }] });
    expect(blocks[3]).toMatchObject({ type: "list", ordered: true, start: 1 });
    expect(blocks[4]).toEqual({ type: "code", lang: "js", text: "const a = '**not bold**';" });
    expect(blocks[7]).toMatchObject({ type: "table", header: [[{ type: "text", text: "Key" }], [{ type: "text", text: "Title" }]], rows: [[[{ type: "code", text: "ABCD2345" }], [{ type: "strong" }]]] });
  });

  it("keeps an unclosed code fence open while streaming", () => {
    expect(parseMarkdown("text\n```\npartial code")).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "text" }] },
      { type: "code", lang: "", text: "partial code" },
    ]);
  });

  it("treats a bold line starting with ** as a paragraph, not a rule or list", () => {
    expect(parseMarkdown("**Bold start** then text")[0].type).toBe("paragraph");
    expect(parseMarkdown("* * *")[0].type).toBe("rule");
  });
});
