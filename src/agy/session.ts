import * as path from "node:path";
import { sessionKey, type NormalizedMessage, type SessionMeta } from "../claude/types.js";

interface TranscriptEntry {
  step_index?: number;
  source?: string;
  type?: string;
  created_at?: string;
  content?: string;
  tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
}

function entries(text: string): TranscriptEntry[] {
  const result: TranscriptEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { result.push(JSON.parse(line) as TranscriptEntry); } catch { /* active partial line */ }
  }
  return result;
}

function userRequest(content: string): string {
  return /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content)?.[1]?.trim() ?? content.trim();
}

function modelFrom(content: string): string | undefined {
  return /changed setting `Model Selection` from .*? to (.+?)\. No need/.exec(content)?.[1]?.trim()
    ?? /changed setting `Model Selection` from .*? to (.+?)(?:\n|$)/.exec(content)?.[1]?.replace(/\.$/, "").trim();
}

export function normalizeAgyTranscript(
  text: string,
  nativeSessionId: string,
  projectPath = "",
  opts: {
    titleBySessionId?: ReadonlyMap<string, string>;
  } = {},
): { meta: Omit<SessionMeta, "filePath" | "mtimeMs">; messages: NormalizedMessage[] } {
  const messages: NormalizedMessage[] = [];
  let model: string | undefined;
  let parsedCustomTitle: string | undefined;
  for (const entry of entries(text)) {
    if (entry.type === "custom-title" && typeof (entry as any).customTitle === "string") {
      parsedCustomTitle = (entry as any).customTitle;
      continue;
    }
    if (entry.source === "USER_EXPLICIT" && entry.type === "USER_INPUT" && entry.content) {
      model = modelFrom(entry.content) ?? model;
      const content = userRequest(entry.content);
      if (content) messages.push({ index: messages.length, role: "user", timestamp: entry.created_at, parts: [{ kind: "text", text: content }] });
    } else if (entry.source === "MODEL" && entry.type === "PLANNER_RESPONSE") {
      if (entry.content?.trim()) messages.push({ index: messages.length, role: "assistant", timestamp: entry.created_at, model, parts: [{ kind: "text", text: entry.content.trim() }] });
      for (const call of entry.tool_calls ?? []) {
        messages.push({ index: messages.length, role: "assistant", timestamp: entry.created_at, model, parts: [{ kind: "tool_use", id: `agy-${entry.step_index ?? messages.length}-${messages.length}`, name: call.name ?? "tool", input: call.args ?? {} }] });
      }
    }
  }
  const first = messages.find((m) => m.role === "user")?.parts[0];
  const customTitleVal = opts.titleBySessionId?.get(nativeSessionId) || parsedCustomTitle;
  const title = customTitleVal || (first?.kind === "text" ? first.text.replace(/\s+/g, " ").slice(0, 80) : "Untitled session");
  return {
    meta: {
      provider: "agy", nativeSessionId, sessionId: sessionKey("agy", nativeSessionId),
      projectPath, projectName: projectPath ? path.basename(projectPath) : "Unknown project",
      title, createdAt: messages[0]?.timestamp ?? "", updatedAt: messages.at(-1)?.timestamp ?? "",
      messageCount: messages.length, cost: null, archived: false, pinned: false,
      parentSessionId: null, subagentCount: 0,
    },
    messages,
  };
}
