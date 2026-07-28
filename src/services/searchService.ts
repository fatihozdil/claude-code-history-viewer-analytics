import { dbAll } from "../storage/db.js";
import { buildSearchSql, type SearchFilter } from "../search/query.js";

export interface SnippetPart {
  text: string;
  match: boolean;
}

export interface SearchResult {
  sessionId: string;
  sessionTitle: string;
  projectName: string;
  projectPath: string;
  msgOrdinal: number;
  snippetParts: SnippetPart[]; // text segments; `match` segments should be highlighted
  searchText: string;          // full matched message text (for highlight fallback)
}

/**
 * Full-text search across indexed conversations.
 *
 * The default sql.js WASM build is compiled without FTS5, so we use a LIKE scan
 * over the indexed `search_text` column. At typical local scale (hundreds of
 * sessions / tens of thousands of messages) this is sub-100ms.
 */
export function search(filter: SearchFilter): SearchResult[] {
  if (!filter.term || filter.term.trim() === "") return [];

  const term = filter.term.trim();
  const { sql, params } = buildSearchSql(filter);
  return dbAll(sql, params).map((r) => mapRow(r, term));
}

function mapRow(r: Record<string, unknown>, term: string): SearchResult {
  const searchText = String(r.search_text ?? "");
  return {
    sessionId: String(r.session_id),
    sessionTitle: String(r.title ?? ""),
    projectName: String(r.project_name ?? ""),
    projectPath: String(r.project_path ?? ""),
    msgOrdinal: Number(r.msg_ordinal ?? 0),
    snippetParts: buildSnippetParts(searchText, term),
    searchText,
  };
}

const SNIPPET_RADIUS = 40;

/**
 * Build snippet text segments centred on the first match, splitting out every
 * occurrence of `term` as its own `match: true` part so callers can render
 * highlights without ever handling raw HTML. Mirrors what FTS5's snippet()
 * would have produced.
 */
function buildSnippetParts(text: string, term: string): SnippetPart[] {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const needle = term.toLowerCase();
  const idx = lower.indexOf(needle);

  let window: string;
  let prefix = "";
  let suffix = "";
  if (idx === -1) {
    window = flat.slice(0, SNIPPET_RADIUS * 2);
    if (flat.length > window.length) suffix = "…";
  } else {
    const start = Math.max(0, idx - SNIPPET_RADIUS);
    const end = Math.min(flat.length, idx + needle.length + SNIPPET_RADIUS);
    window = flat.slice(start, end);
    if (start > 0) prefix = "…";
    if (end < flat.length) suffix = "…";
  }

  const parts: SnippetPart[] = [];
  if (prefix) parts.push({ text: prefix, match: false });

  const lowWindow = window.toLowerCase();
  let pos = 0;
  for (;;) {
    const at = lowWindow.indexOf(needle, pos);
    if (at === -1) {
      if (pos < window.length) parts.push({ text: window.slice(pos), match: false });
      break;
    }
    if (at > pos) parts.push({ text: window.slice(pos, at), match: false });
    parts.push({ text: window.slice(at, at + needle.length), match: true });
    pos = at + needle.length;
  }

  if (suffix) parts.push({ text: suffix, match: false });
  return parts;
}
