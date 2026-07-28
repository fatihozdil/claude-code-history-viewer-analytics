import * as path from "node:path";
import type {
  RawEntry, NormalizedMessage, MessagePart, SessionMeta,
} from "./types.js";
import { sessionKey } from "./types.js";
import { extractMessageUsage } from "./tokens.js";
import { costForTokens } from "../services/pricing.js";
import { extractCost } from "./cost.js";

export interface NormalizedSession {
  meta: Omit<SessionMeta, "filePath" | "mtimeMs">;
  messages: NormalizedMessage[];
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c): c is { type: string; text: string } =>
        !!c && typeof c === "object" && (c as any).type === "text")
      .map((c) => c.text);
    if (texts.length > 0) return texts.join("\n");
  }
  return JSON.stringify(content ?? "");
}

function toParts(content: unknown): MessagePart[] {
  if (typeof content === "string") {
    const text = content.trim();
    return text === "" ? [] : [{ kind: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const parts: MessagePart[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const t = (item as any).type;
    if (t === "text" && typeof (item as any).text === "string") {
      parts.push({ kind: "text", text: (item as any).text });
    } else if (t === "tool_use") {
      parts.push({
        kind: "tool_use",
        id: String((item as any).id ?? ""),
        name: String((item as any).name ?? "tool"),
        input: ((item as any).input ?? {}) as Record<string, unknown>,
      });
    } else if (t === "tool_result") {
      parts.push({
        kind: "tool_result",
        toolUseId: String((item as any).tool_use_id ?? ""),
        text: stringifyToolResult((item as any).content),
        isError: Boolean((item as any).is_error),
      });
    }
  }
  return parts;
}

function roleOf(entry: RawEntry): "user" | "assistant" | "system" | null {
  if (entry.type === "user") return "user";
  if (entry.type === "assistant") return "assistant";
  if (entry.type === "system") return "system";
  return null;
}

const LOCAL_COMMAND_TAG = /<(local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args)>/;

function isLocalCommandMessage(parts: MessagePart[]): boolean {
  const textParts = parts.filter((p) => p.kind === "text") as { kind: "text"; text: string }[];
  if (textParts.length === 0 || textParts.length !== parts.length) return false;
  return textParts.every((p) => LOCAL_COMMAND_TAG.test(p.text));
}

function isCommandTitle(t: string): boolean {
  return t.startsWith("/") || t.startsWith("<local-command") || t.startsWith("<command-");
}

export function normalizeSession(
  entries: RawEntry[],
  fallbackSessionId: string,
): NormalizedSession {
  let sessionId = "";
  let projectPath = "";
  let summaryTitle = "";
  let firstUserText = "";
  let createdAt = "";
  let updatedAt = "";
  let parentSessionId: string | null = null;

  const messages: NormalizedMessage[] = [];
  for (const entry of entries) {
    if (!sessionId && entry.sessionId) sessionId = entry.sessionId;
    if (!projectPath && entry.cwd) projectPath = entry.cwd;

    // Use ai-title (real data) or summary (legacy / test fixtures)
    if (entry.type === "ai-title" && typeof (entry as any).aiTitle === "string") {
      const val = (entry as any).aiTitle;
      if (!isCommandTitle(val)) {
        summaryTitle = val;
      }
    }
    if (entry.type === "summary" && typeof entry.summary === "string") {
      const val = entry.summary;
      if (!isCommandTitle(val)) {
        summaryTitle = val;
      }
    }
    // Branch session title set by /branch command
    if (entry.type === "custom-title" && typeof (entry as any).customTitle === "string") {
      const val = (entry as any).customTitle;
      if (!isCommandTitle(val)) {
        summaryTitle = val;
      }
    }
    // Branch detection: forkedFrom appears on every entry in a branch session
    if (!parentSessionId && (entry as any).forkedFrom?.sessionId) {
      parentSessionId = String((entry as any).forkedFrom.sessionId);
    }
    if (typeof entry.timestamp === "string" && entry.timestamp !== "") {
      if (createdAt === "" || entry.timestamp < createdAt) createdAt = entry.timestamp;
      if (updatedAt === "" || entry.timestamp > updatedAt) updatedAt = entry.timestamp;
    }
    const role = roleOf(entry);
    if (!role) continue;
    const parts = toParts(entry.message?.content);
    if (parts.length === 0) continue;
    if (isLocalCommandMessage(parts)) continue;
    if (!firstUserText && role === "user") {
      const firstText = parts.find((p) => p.kind === "text") as
        | { kind: "text"; text: string } | undefined;
      if (firstText) {
        const trimmed = firstText.text.trim();
        // Skip slash commands and local-command wrapper messages for titling —
        // the first real user message gives a better label.
        if (!trimmed.startsWith("/") && !trimmed.startsWith("<local-command") && !trimmed.startsWith("<command-")) {
          firstUserText = trimmed.slice(0, 80);
        }
      }
    }
    const usage = role === "assistant" ? extractMessageUsage(entry) : null;
    messages.push({
      index: messages.length, role, timestamp: entry.timestamp, parts,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cacheCreationTokens: usage?.cacheCreationTokens,
      cacheReadTokens: usage?.cacheReadTokens,
      model: usage?.model ?? undefined,
    });
  }

  const resolvedId = sessionId || fallbackSessionId;
  const title = summaryTitle || firstUserText || "Untitled session";
  const projectName = projectPath ? path.basename(projectPath) : "Unknown project";

  let calculatedCost = 0;
  let hasCalculatedCost = false;
  for (const msg of messages) {
    if (msg.role === "assistant" && (msg.inputTokens || msg.outputTokens)) {
      calculatedCost += costForTokens(msg.model, {
        input: msg.inputTokens ?? 0,
        output: msg.outputTokens ?? 0,
        cacheCreation: msg.cacheCreationTokens ?? 0,
        cacheRead: msg.cacheReadTokens ?? 0,
      });
      hasCalculatedCost = true;
    }
  }
  const sessionCost = extractCost(entries) ?? (hasCalculatedCost ? calculatedCost : null);

  return {
    meta: {
      sessionId: sessionKey("claude", resolvedId),
      nativeSessionId: resolvedId, provider: "claude",
      projectPath, projectName, title,
      createdAt, updatedAt, messageCount: messages.length,
      cost: sessionCost, archived: false, pinned: false, parentSessionId,
      subagentCount: 0,
    },
    messages,
  };
}
