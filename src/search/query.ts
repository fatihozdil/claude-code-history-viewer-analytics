import type { ProviderFilter } from "../services/providerFilter.js";
import { providerFilterSql } from "../services/providerFilter.js";

export interface SearchFilter {
  term: string;
  projectPath?: string;
  sessionId?: string;
  includeArchived?: boolean;
  archivedOnly?: boolean;
  providerFilter?: ProviderFilter;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

function escapeLike(value: string): string {
  return value.toLowerCase().replace(/([\\%_])/g, "\\$1");
}

/** Build the conversation search query, with title matches ranked first. */
export function buildSearchSql(filter: SearchFilter): BuiltQuery {
  const likeTerm = `%${escapeLike(filter.term.trim())}%`;
  const params: unknown[] = [likeTerm, likeTerm, likeTerm];
  let sql = `
    SELECT
      s.session_id,
      s.title,
      s.project_name,
      s.project_path,
      m.ordinal AS msg_ordinal,
      m.search_text
    FROM messages m
    JOIN sessions s ON s.session_id = m.session_id
    WHERE (LOWER(m.search_text) LIKE ? ESCAPE '\\'
       OR LOWER(COALESCE(s.title, '')) LIKE ? ESCAPE '\\')
      AND (LOWER(COALESCE(s.title, '')) NOT LIKE ? ESCAPE '\\'
        OR m.ordinal = (SELECT MIN(first_message.ordinal)
                        FROM messages first_message
                        WHERE first_message.session_id = s.session_id))
  `;

  if (filter.projectPath) {
    const sep = filter.projectPath.includes("\\") ? "\\" : "/";
    const escaped = filter.projectPath.replace(/([\\%_])/g, "\\$1");
    sql += " AND (s.project_path = ? OR s.project_path LIKE ? ESCAPE '\\')";
    params.push(filter.projectPath, escaped + sep + "%");
  }
  if (filter.sessionId) {
    sql += " AND s.session_id = ?";
    params.push(filter.sessionId);
  }
  if (filter.archivedOnly) {
    sql += " AND s.archived = 1";
  } else if (!filter.includeArchived) {
    sql += " AND s.archived = 0";
  }
  sql += ` AND ${providerFilterSql(filter.providerFilter ?? "all")}`;

  // A title is the conversation's concise label (and may be explicitly set by
  // the user), so it is a stronger relevance signal than message content. A
  // title hit contributes only one row above, preventing a long conversation
  // from consuming the result limit once for every message it contains.
  sql += " ORDER BY CASE WHEN LOWER(COALESCE(s.title, '')) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, s.updated_at DESC, m.ordinal ASC LIMIT 500";
  params.push(likeTerm);
  return { sql, params };
}
