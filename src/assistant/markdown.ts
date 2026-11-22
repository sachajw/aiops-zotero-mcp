/**
 * A small Markdown parser for model replies: the subset models actually write (headings,
 * paragraphs, lists, code, quotes, rules, tables, bold, italic, inline code, links). It produces
 * a tree that ui/markdown.ts turns into DOM nodes with textContent, so no reply is ever parsed as
 * HTML. Unclosed markers (common while a reply streams in) stay as plain text. Pure.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "break" };

export interface ListItem {
  depth: number;
  content: Inline[];
}

export type Block =
  | { type: "heading"; level: number; content: Inline[] }
  | { type: "paragraph"; content: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; blocks: Block[] }
  | { type: "rule" }
  | { type: "table"; header: Inline[][]; rows: Inline[][][] };

// ------------------------------------------------------------------- inline

/** Earliest match of any inline marker in `text`, from `from`. */
const INLINE = [
  { type: "code" as const, re: /`([^`\n]+)`/g },
  { type: "link" as const, re: /\[([^\]\n]+)\]\(([^)\s]+)\)/g },
  { type: "url" as const, re: /\bhttps?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?'"]/g },
  { type: "strong" as const, re: /\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__/g },
  { type: "em" as const, re: /(?<![*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])|(?<![_\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![_\w])/g },
];

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const lines = t.split("\n");
    lines.forEach((line, i) => {
      if (i > 0) out.push({ type: "break" });
      if (!line) return;
      const last = out.at(-1);
      if (last?.type === "text") last.text += line;
      else out.push({ type: "text", text: line });
    });
  };
  let pos = 0;
  while (pos < text.length) {
    let best: { type: (typeof INLINE)[number]["type"]; match: RegExpExecArray } | undefined;
    for (const { type, re } of INLINE) {
      re.lastIndex = pos;
      const match = re.exec(text);
      if (match && (!best || match.index < best.match.index)) best = { type, match };
    }
    if (!best) break;
    const { type, match } = best;
    pushText(text.slice(pos, match.index));
    if (type === "code") out.push({ type: "code", text: match[1] });
    else if (type === "link") out.push({ type: "link", href: match[2], children: parseInline(match[1]) });
    else if (type === "url") out.push({ type: "link", href: match[0], children: [{ type: "text", text: match[0] }] });
    else out.push({ type, children: parseInline(match[1] ?? match[2]) });
    pos = match.index + match[0].length;
  }
  pushText(text.slice(pos));
  return out;
}

// -------------------------------------------------------------------- block

const LIST_ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || LIST_ITEM.test(line) || /^\s{0,3}>/.test(line);
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++; // the closing fence (or the end, while streaming)
      blocks.push({ type: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, content: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (RULE.test(line) && !LIST_ITEM.test(line.replace(/\s/g, "") + " x")) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      blocks.push({ type: "quote", blocks: parseMarkdown(quoted.join("\n")) });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const header = tableCells(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(tableCells(lines[i++]).map(parseInline));
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const first = LIST_ITEM.exec(line);
    if (first) {
      const ordered = Boolean(first[3]);
      const baseIndent = first[1].length;
      const items: ListItem[] = [];
      let current: { depth: number; text: string } | undefined;
      const flush = () => {
        if (current) items.push({ depth: current.depth, content: parseInline(current.text) });
        current = undefined;
      };
      while (i < lines.length) {
        const l = lines[i];
        const m = LIST_ITEM.exec(l);
        if (m && Boolean(m[3]) === ordered && m[1].length <= baseIndent + 1 && m[1].length >= baseIndent) {
          flush();
          current = { depth: 0, text: m[4] };
        } else if (m && m[1].length > baseIndent + 1) {
          flush();
          current = { depth: Math.min(3, Math.floor((m[1].length - baseIndent) / 2)), text: m[4] };
        } else if (l.trim() && /^\s+/.test(l) && current) {
          current.text += `\n${l.trim()}`;
        } else {
          break;
        }
        i++;
        // A blank line inside a list continues it only if the next line is another item.
        while (i < lines.length && !lines[i].trim() && i + 1 < lines.length && LIST_ITEM.test(lines[i + 1])) i++;
      }
      flush();
      blocks.push({ type: "list", ordered, start: ordered ? Number(first[3]) : 1, items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i]))) para.push(lines[i++].trim());
    blocks.push({ type: "paragraph", content: parseInline(para.join("\n")) });
  }
  return blocks;
}
