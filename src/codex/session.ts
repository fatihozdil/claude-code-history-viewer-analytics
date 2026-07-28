import * as path from "node:path";
import {
  sessionKey,
  type MessagePart,
  type NormalizedMessage,
} from "../claude/types.js";
import { parseCodexJsonl } from "./jsonl.js";
import type {
  CodexEntry,
  CodexNormalizeOptions,
  NormalizedCodexSession,
} from "./types.js";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function payloadOf(entry: CodexEntry): Record<string, unknown> {
  return entry.payload && typeof entry.payload === "object" ? entry.payload : {};
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Custom tools often store their input as a non-JSON source string.
    }
    return { input: value };
  }
  return {};
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(stringifyToolOutput).filter((part) => part !== "").join("\n");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const text = nonEmptyString(record.text)
      ?? nonEmptyString(record.output_text)
      ?? nonEmptyString(record.message);
    if (text) return text;
    if (record.content !== undefined) return stringifyToolOutput(record.content);
  }
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function hasError(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasError);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.isError === true
    || record.is_error === true
    || record.status === "failed"
    || record.status === "error";
}

function assistantTextParts(payload: Record<string, unknown>): MessagePart[] {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const parts: MessagePart[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "output_text" && record.type !== "text") continue;
    const text = nonEmptyString(record.text);
    if (text) parts.push({ kind: "text", text });
  }
  return parts;
}

function firstSessionMeta(entries: CodexEntry[]): Record<string, unknown> {
  for (const entry of entries) {
    if (entry.type === "session_meta") return payloadOf(entry);
  }
  return {};
}

/** Normalize Codex rollout entries into the viewer's provider-neutral model. */
export function normalizeCodexSession(
  entries: CodexEntry[],
  fallbackNativeSessionId: string,
  options: CodexNormalizeOptions = {},
): NormalizedCodexSession {
  const sessionMeta = firstSessionMeta(entries);
  const nativeSessionId = nonEmptyString(sessionMeta.id)
    ?? nonEmptyString(sessionMeta.session_id)
    ?? fallbackNativeSessionId;
  const projectPath = nonEmptyString(sessionMeta.cwd) ?? "";

  let createdAt = "";
  let updatedAt = "";
  let currentModel: string | undefined;
  let customTitleVal: string | undefined;
  let previousUsage = { input: 0, cached: 0, output: 0 };
  const messages: NormalizedMessage[] = [];
  const turnStarts: number[] = [];

  const addMessage = (
    role: NormalizedMessage["role"],
    timestamp: string | undefined,
    parts: MessagePart[],
  ): void => {
    if (parts.length === 0) return;
    messages.push({
      index: messages.length,
      role,
      timestamp,
      parts,
      model: currentModel,
    });
  };

  for (const entry of entries) {
    if (entry.type === "custom-title" && typeof (entry as any).customTitle === "string") {
      customTitleVal = (entry as any).customTitle;
      continue;
    }

    const timestamp = nonEmptyString(entry.timestamp) ?? undefined;
    if (timestamp) {
      if (createdAt === "" || timestamp < createdAt) createdAt = timestamp;
      if (updatedAt === "" || timestamp > updatedAt) updatedAt = timestamp;
    }

    const payload = payloadOf(entry);
    if (entry.type === "turn_context") {
      currentModel = nonEmptyString(payload.model) ?? currentModel;
      continue;
    }

    // Codex emits cumulative token_count events. Convert them to deltas and
    // attach each delta to the latest assistant message so costs work in both
    // the conversation view and the analytics index.
    if (entry.type === "event_msg" && payload.type === "token_count") {
      const info = payload.info && typeof payload.info === "object"
        ? payload.info as Record<string, unknown> : {};
      const usage = info.total_token_usage && typeof info.total_token_usage === "object"
        ? info.total_token_usage as Record<string, unknown> : {};
      const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
      const next = {
        input: number(usage.input_tokens),
        cached: number(usage.cached_input_tokens),
        output: number(usage.output_tokens) + number(usage.reasoning_output_tokens),
      };
      const target = [...messages].reverse().find((message) => message.role === "assistant");
      if (target) {
        target.inputTokens = Math.max(0, next.input - previousUsage.input - (next.cached - previousUsage.cached));
        target.cacheReadTokens = Math.max(0, next.cached - previousUsage.cached);
        target.outputTokens = Math.max(0, next.output - previousUsage.output);
        target.model ??= currentModel;
      }
      previousUsage = next;
      continue;
    }

    if (entry.type === "event_msg" && payload.type === "thread_rolled_back") {
      const count = typeof payload.num_turns === "number"
        ? Math.max(0, Math.floor(payload.num_turns))
        : 0;
      let removeFrom = messages.length;
      for (let i = 0; i < count; i += 1) {
        const start = turnStarts.pop();
        if (start === undefined) break;
        removeFrom = Math.min(removeFrom, start);
      }
      messages.splice(removeFrom);
      continue;
    }

    // event_msg contains the clean, user-visible prompt without the injected
    // developer instructions and environment context found in response_item.
    if (entry.type === "event_msg" && payload.type === "user_message") {
      const text = nonEmptyString(payload.message);
      if (!text) continue;
      turnStarts.push(messages.length);
      addMessage("user", timestamp, [{ kind: "text", text }]);
      continue;
    }

    if (entry.type !== "response_item") continue;
    const responseType = payload.type;

    // Use the response item for assistant text and ignore event_msg's duplicate
    // agent_message event.
    if (responseType === "message" && payload.role === "assistant") {
      addMessage("assistant", timestamp, assistantTextParts(payload));
      continue;
    }

    if (responseType === "function_call" || responseType === "custom_tool_call") {
      const id = nonEmptyString(payload.call_id) ?? `codex-tool-${messages.length}`;
      const name = nonEmptyString(payload.name) ?? "tool";
      const rawInput = responseType === "function_call" ? payload.arguments : payload.input;
      addMessage("assistant", timestamp, [{
        kind: "tool_use",
        id,
        name,
        input: parseToolInput(rawInput),
      }]);
      continue;
    }

    if (responseType === "function_call_output" || responseType === "custom_tool_call_output") {
      const id = nonEmptyString(payload.call_id) ?? "";
      addMessage("system", timestamp, [{
        kind: "tool_result",
        toolUseId: id,
        text: stringifyToolOutput(payload.output),
        isError: hasError(payload) || hasError(payload.output),
      }]);
    }
  }

  const indexedTitle = options.titleBySessionId?.get(nativeSessionId)?.trim() ?? "";
  const firstUserText = messages
    .find((message) => message.role === "user")
    ?.parts.find((part): part is Extract<MessagePart, { kind: "text" }> => part.kind === "text")
    ?.text.trim().slice(0, 80) ?? "";
  const title = customTitleVal || indexedTitle || firstUserText || "Untitled session";
  const projectName = projectPath ? path.basename(projectPath) || projectPath : "Unknown project";

  return {
    meta: {
      provider: "codex",
      nativeSessionId,
      sessionId: sessionKey("codex", nativeSessionId),
      projectPath,
      projectName,
      title,
      createdAt,
      updatedAt,
      messageCount: messages.length,
      cost: null,
      archived: options.archived ?? false,
      pinned: false,
      parentSessionId: null,
      subagentCount: 0,
    },
    messages,
  };
}

/** Parse and normalize a Codex rollout in one step for on-demand loading. */
export function parseAndNormalizeCodexSession(
  text: string,
  fallbackNativeSessionId: string,
  options: CodexNormalizeOptions = {},
): NormalizedCodexSession {
  return normalizeCodexSession(
    parseCodexJsonl(text),
    fallbackNativeSessionId,
    options,
  );
}
