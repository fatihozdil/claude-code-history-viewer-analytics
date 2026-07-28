export type FileOperation = "Read" | "Write" | "Edit" | "MultiEdit";

export type SessionProvider = "claude" | "codex" | "agy";

/**
 * Return the globally unique key stored in the local index.
 *
 * Claude keys keep their historical shape so existing archive/pin state can
 * migrate in place. Codex keys are namespaced because both products use UUIDs
 * and a collision must never make one provider overwrite the other.
 */
export function sessionKey(provider: SessionProvider, nativeSessionId: string): string {
  return provider === "claude" ? nativeSessionId : `${provider}:${nativeSessionId}`;
}

export interface RawEntry {
  type?: string;            // "user" | "assistant" | "summary" | "system" | ...
  uuid?: string;
  timestamp?: string;       // ISO 8601
  sessionId?: string;
  cwd?: string;
  summary?: string;         // present on summary entries
  message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; toolUseId: string; text: string; isError: boolean };

export interface NormalizedMessage {
  index: number;
  role: "user" | "assistant" | "system";
  timestamp?: string;
  parts: MessagePart[];
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  model?: string;
}

export interface SessionMeta {
  sessionId: string;        // globally unique key used by the local index
  nativeSessionId: string;  // provider-native ID used by resume commands
  provider: SessionProvider;
  projectPath: string;      // absolute cwd of the session
  projectName: string;      // basename of projectPath
  title: string;
  createdAt: string;        // ISO; "" if unknown
  updatedAt: string;        // ISO; "" if unknown
  filePath: string;         // absolute path to the .jsonl file
  mtimeMs: number;          // file mtime for incremental refresh
  messageCount: number;
  cost: number | null;      // USD from costUSD if present, else null
  archived: boolean;        // archive flag
  pinned: boolean;          // pin flag (pinned sessions sort to the top)
  parentSessionId: string | null;   // null = root session; non-null = branch
  subagentCount: number;
}

export interface FileChange {
  sessionId: string;
  filePath: string;
  operation: FileOperation;
  timestamp?: string;
  messageIndex: number;
  linesAdded: number;
  linesRemoved: number;
}
