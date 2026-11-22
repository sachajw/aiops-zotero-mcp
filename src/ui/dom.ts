/**
 * DOM helpers for the Assistant UI. Everything is built with createElementNS and textContent:
 * the item pane is a privileged window, so model and document text must never be parsed as markup.
 */
import { ACTIVE_PROFILE_PREF, PROFILE_FILES_PREF, profileFiles, profileLabel } from "../assistant/config.js";

export const HTML_NS = "http://www.w3.org/1999/xhtml";

export function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, text?: string, style?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (text !== undefined) node.textContent = text;
  if (style) node.setAttribute("style", style);
  return node;
}

export function button(doc: Document, label: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = el(doc, "button", label, "margin: 0 6px 6px 0;");
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

export function checkbox(doc: Document, label: string, checked: boolean, note?: string): { row: HTMLElement; input: HTMLInputElement } {
  const row = el(doc, "label", undefined, "display: block; margin: 2px 0;");
  const input = el(doc, "input");
  input.type = "checkbox";
  input.checked = checked;
  row.append(input, doc.createTextNode(` ${label}`));
  if (note) row.append(el(doc, "span", ` ${note}`, "opacity: 0.7;"));
  return { row, input };
}

/** The configured profile labels and the one in use. */
export function backends(): { labels: string[]; active: string | undefined } {
  const labels = profileFiles(Zotero.Prefs.get(PROFILE_FILES_PREF, true)).map(profileLabel);
  const wanted = String(Zotero.Prefs.get(ACTIVE_PROFILE_PREF, true) ?? "").trim();
  return { labels, active: wanted && labels.includes(wanted) ? wanted : labels[0] };
}

export function backendSummary(): string {
  return backends().active ?? "not set up";
}

/** A picker for the backend; changing it sets the active-profile pref. */
export function backendPicker(doc: Document, onChange: () => void): HTMLElement {
  const { labels, active } = backends();
  const row = el(doc, "div", undefined, "margin: 0 0 6px 0;");
  if (!labels.length) {
    row.append(el(doc, "span", `Model backend not set up: set ${PROFILE_FILES_PREF} in the Config Editor.`, "opacity: 0.7;"));
    return row;
  }
  const select = el(doc, "select");
  for (const label of labels) {
    const option = el(doc, "option", label);
    option.value = label;
    option.selected = label === active;
    select.append(option);
  }
  select.addEventListener("change", () => {
    Zotero.Prefs.set(ACTIVE_PROFILE_PREF, select.value, true);
    onChange();
  });
  row.append(el(doc, "span", "Model backend: "), select);
  return row;
}
