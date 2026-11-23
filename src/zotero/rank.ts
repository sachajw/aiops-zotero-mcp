/**
 * Relevance ranking for zotero_search_items. Zotero's search only says whether an item matches,
 * so the order comes from here: each search term scores by where it appears (title highest, then
 * creators, year, publication and tags, then any other field), plus a bonus when the whole query
 * appears in the title. A term that matched only somewhere we don't read (full text, notes,
 * annotations) still scores a little, so those items sort after the ones that match in fields.
 *
 * Pure: the caller reads the fields from Zotero and passes them in, so unit tests run without it.
 */

/** The text of one item that ranking looks at. */
export interface RankFields {
  title: string;
  /** Last names (or single-field names) and first names, kept apart so a last-name hit scores higher. */
  creators: Array<{ lastName: string; firstName?: string }>;
  year: string;
  /** Publication, short title, court: the other fields Zotero's title/creator/year search reads. */
  publication: string[];
  tags: string[];
  /** Every other field value; read only in the all_fields and everything modes. */
  other: string[];
}

/** Case- and accent-insensitive, as Zotero's own search is. */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Where `term` occurs in `text`: 2 = as a whole word, 1 = at the start of a word, 0.5 = inside one, 0 = not at all. */
export function matchStrength(text: string, term: string): number {
  if (!term) return 0;
  let best = 0;
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
    const startsWord = at === 0 || !WORD_CHAR.test(text.charAt(at - 1));
    const end = at + term.length;
    const endsWord = end === text.length || !WORD_CHAR.test(text.charAt(end));
    best = Math.max(best, startsWord ? (endsWord ? 2 : 1) : 0.5);
    if (best === 2) break;
  }
  return best;
}

const WEIGHT = { title: 4, lastName: 3, firstName: 1.5, year: 2, publication: 1.5, tag: 1.5, other: 0.5 };
/** A term that matched only outside the fields read here (full text, notes, annotations). */
const UNSEEN_MATCH = 0.1;

function bestIn(texts: string[], term: string): number {
  let best = 0;
  for (const t of texts) best = Math.max(best, matchStrength(t, term));
  return best;
}

/** Score of one item for the search terms (as Zotero.SearchConditions.parseSearchString splits them). */
export function relevanceScore(terms: string[], fields: RankFields): number {
  const n = {
    title: normalize(fields.title),
    last: fields.creators.map((c) => normalize(c.lastName)),
    first: fields.creators.map((c) => normalize(c.firstName ?? "")),
    year: normalize(fields.year),
    publication: fields.publication.map(normalize),
    tags: fields.tags.map(normalize),
    other: fields.other.map(normalize),
  };
  const words = terms.map(normalize).filter(Boolean);
  let score = 0;
  for (const term of words) {
    const termScore =
      WEIGHT.title * matchStrength(n.title, term) +
      WEIGHT.lastName * bestIn(n.last, term) +
      WEIGHT.firstName * bestIn(n.first, term) +
      WEIGHT.year * matchStrength(n.year, term) +
      WEIGHT.publication * bestIn(n.publication, term) +
      WEIGHT.tag * bestIn(n.tags, term) +
      WEIGHT.other * bestIn(n.other, term);
    score += termScore || UNSEEN_MATCH;
  }
  // The whole query in the title (in order) beats the same words scattered; an exact title most of all.
  const phrase = words.join(" ");
  if (words.length > 1 && n.title.includes(phrase)) score += WEIGHT.title * 2;
  if (phrase && n.title === phrase) score += WEIGHT.title * 2;
  return score;
}

/** IDs by score, highest first; equal scores keep item-ID order, so pages stay stable. */
export function rankByScore(scored: Array<{ id: number; score: number }>): number[] {
  return [...scored].sort((a, b) => b.score - a.score || a.id - b.id).map((s) => s.id);
}
