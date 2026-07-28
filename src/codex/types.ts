import type { NormalizedMessage, SessionMeta } from "../claude/types.js";

/** One line from a Codex rollout JSONL file. */
export interface CodexEntry {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CodexNormalizeOptions {
  /** Native Codex archive state inferred from the rollout's containing folder. */
  archived?: boolean;
  /** Optional names loaded from Codex's session_index.jsonl. */
  titleBySessionId?: ReadonlyMap<string, string>;
}

export interface NormalizedCodexSession {
  meta: Omit<SessionMeta, "filePath" | "mtimeMs"> & {
    provider: "codex";
    nativeSessionId: string;
  };
  messages: NormalizedMessage[];
}
