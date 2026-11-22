/**
 * Renders parsed Markdown (assistant/markdown.ts) as DOM nodes built with createElementNS and
 * textContent only: model text is never parsed as HTML in this privileged window. Links open in
 * the system browser, and only for http(s).
 */
import { type Block, type Inline, parseMarkdown } from "../assistant/markdown.js";
import { el } from "./dom.js";

function inline(doc: Document, nodes: Inline[], parent: HTMLElement): void {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        parent.append(doc.createTextNode(node.text));
        break;
      case "break":
        parent.append(el(doc, "br"));
        break;
      case "code":
        parent.append(el(doc, "code", node.text, "font-family: monospace; background: var(--fill-quinary, rgba(127,127,127,0.15)); padding: 0 3px; border-radius: 3px;"));
        break;
      case "strong":
      case "em": {
        const span = el(doc, node.type === "strong" ? "strong" : "em");
        inline(doc, node.children, span);
        parent.append(span);
        break;
      }
      case "link": {
        const safe = /^https?:\/\//i.test(node.href);
        const a = el(doc, "span", undefined, safe ? "color: var(--accent-blue, #2a6ed1); text-decoration: underline; cursor: pointer;" : "");
        inline(doc, node.children, a);
        if (safe) {
          a.title = node.href;
          a.addEventListener("click", () => Zotero.launchURL(node.href));
        }
        parent.append(a);
        break;
      }
    }
  }
}

function block(doc: Document, b: Block): HTMLElement {
  switch (b.type) {
    case "heading": {
      const h = el(doc, "div", undefined, `font-weight: 700; font-size: ${b.level <= 2 ? "1.1em" : "1em"}; margin: 8px 0 4px;`);
      inline(doc, b.content, h);
      return h;
    }
    case "paragraph": {
      const p = el(doc, "div", undefined, "margin: 4px 0;");
      inline(doc, b.content, p);
      return p;
    }
    case "list": {
      const list = el(doc, b.ordered ? "ol" : "ul", undefined, "margin: 4px 0; padding-left: 1.4em;");
      if (b.ordered && b.start !== 1) list.setAttribute("start", String(b.start));
      for (const item of b.items) {
        const li = el(doc, "li", undefined, item.depth ? `margin-left: ${item.depth * 1.2}em;` : "");
        inline(doc, item.content, li);
        list.append(li);
      }
      return list;
    }
    case "code":
      return el(doc, "pre", b.text, "font-family: monospace; white-space: pre-wrap; background: var(--fill-quinary, rgba(127,127,127,0.15)); padding: 6px; border-radius: 4px; margin: 4px 0;");
    case "quote": {
      const q = el(doc, "div", undefined, "border-left: 3px solid var(--fill-tertiary, #999); padding-left: 8px; margin: 4px 0; opacity: 0.9;");
      for (const child of b.blocks) q.append(block(doc, child));
      return q;
    }
    case "rule":
      return el(doc, "hr", undefined, "border: none; border-top: 1px solid var(--fill-tertiary, #999); margin: 8px 0;");
    case "table": {
      const wrap = el(doc, "div", undefined, "overflow-x: auto; margin: 4px 0;");
      const table = el(doc, "table", undefined, "border-collapse: collapse;");
      const cell = (tag: "th" | "td", content: Inline[]) => {
        const c = el(doc, tag, undefined, "border: 1px solid var(--fill-tertiary, #999); padding: 2px 6px; text-align: left; vertical-align: top;");
        inline(doc, content, c);
        return c;
      };
      const head = el(doc, "tr");
      b.header.forEach((h) => head.append(cell("th", h)));
      table.append(head);
      for (const row of b.rows) {
        const tr = el(doc, "tr");
        row.forEach((c) => tr.append(cell("td", c)));
        table.append(tr);
      }
      wrap.append(table);
      return wrap;
    }
  }
}

/** A reply rendered as formatted, selectable text. */
export function renderMarkdown(doc: Document, text: string): HTMLElement {
  const box = el(doc, "div", undefined, "user-select: text;");
  for (const b of parseMarkdown(text)) box.append(block(doc, b));
  return box;
}
