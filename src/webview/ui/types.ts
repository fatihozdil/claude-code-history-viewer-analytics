// src/webview/ui/types.ts
// Shared types for the webview UI. Mirrors the host's SessionCard shape.

export type SortMode = "newest" | "oldest" | "messages" | "activity" | "cost" | "impact";
export type ProviderFilter = "all" | "claude" | "codex" | "agy" | "deepseek";

export interface SessionCard {
  provider: "claude" | "codex" | "agy";
  sessionId: string;
  projectPath: string;
  projectName: string;
  title: string;
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
  messageCount: number;
  cost: number | null;     // USD, null if unavailable
  archived: boolean;
  pinned: boolean;
  filesModified: number;
  linesAdded: number;
  linesRemoved: number;
  parentSessionId: string | null;
  possibleParentId: string | null;  // heuristic IDE-fork parent (lower confidence)
  forkDismissed?: boolean;          // user marked this session "not a fork"
  ungrouped?: boolean;              // user promoted this branch out of its group
  branchCount: number;
  subagentCount: number;
  matchOrdinal?: number;
  matchCount?: number;
  matchSnippet?: SnippetPart[];
}

export interface SnippetPart {
  text: string;
  match: boolean;   // true if this segment should be rendered highlighted
}

export interface SubagentMeta {
  agentId: string;
  description: string;
  agentType: string;
  isFork: boolean;
  spawnDepth: number;
  jsonlPath: string;
}

export interface ProjectInfo {
  path: string;
  name: string;
}

export interface AppState {
  sessions: SessionCard[];
  projects: ProjectInfo[];
  selectedProject: string | null;  // null = All Projects
  sort: SortMode;
  compact: boolean;
  showArchived: boolean;
  providerFilter: ProviderFilter;
  searchQuery: string;
  searchActive: boolean;
  loading: boolean;
}

// Host → Webview messages
export type HostMessage =
  | { type: "state"; sessions: SessionCard[]; projects: ProjectInfo[]; sort: SortMode; compact: boolean; showArchived: boolean; selectedProject: string | null; providerFilter: ProviderFilter }
  | { type: "searchResults"; sessions: SessionCard[]; query: string }
  | { type: "searchCleared" }
  | { type: "loading"; loading: boolean }
  | { type: "subagentsLoaded"; sessionId: string; subagents: SubagentMeta[] };

// Webview → Host messages
export type CommandMessage =
  | { command: "ready" }
  | { command: "setProject"; projectPath: string | null }
  | { command: "setProvider"; providerFilter: ProviderFilter }
  | { command: "search"; query: string }
  | { command: "clearSearch" }
  | { command: "setSort"; sort: SortMode }
  | { command: "toggleCompact" }
  | { command: "toggleArchived" }
  | { command: "openSession"; sessionId: string; msgOrdinal?: number; highlightTerm?: string }
  | { command: "openSubagent"; filePath: string; title: string }
  | { command: "getSubagents"; sessionId: string }
  | { command: "archive"; sessionId: string }
  | { command: "unarchive"; sessionId: string }
  | { command: "pin"; sessionId: string }
  | { command: "unpin"; sessionId: string }
  | { command: "refresh" }
  | { command: "openSettings" }
  | { command: "resume.copy"; sessionId: string }
  | { command: "resume.run"; sessionId: string }
  | { command: "resume.openInClaudeTab"; sessionId: string }
  | { command: "rename"; sessionId: string; title: string }
  | { command: "dismissFork"; sessionId: string }
  | { command: "restoreFork"; sessionId: string }
  | { command: "ungroupBranch"; sessionId: string }
  | { command: "regroupBranch"; sessionId: string };
