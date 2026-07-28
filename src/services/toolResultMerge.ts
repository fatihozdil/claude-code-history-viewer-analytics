export interface SerializedTextPart {
  kind: "text";
  text: string;
}

export interface SerializedToolUsePart {
  kind: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: { text: string; isError: boolean; index: number };
}

export interface SerializedToolResultPart {
  kind: "tool_result";
  toolUseId: string;
  text: string;
  isError: boolean;
}

export type SerializedPart = SerializedTextPart | SerializedToolUsePart | SerializedToolResultPart;

export interface SerializedMessage {
  index: number;
  role: "user" | "assistant" | "system";
  timestamp?: string;
  parts: SerializedPart[];
  model?: string;
  cost?: number;
}

/**
 * Pair each tool_use part with its matching tool_result (by id) so the result
 * can render inside the tool_use's own card instead of as a separate
 * "user"-role message. Messages left with no parts after stripping merged
 * results are dropped entirely; unmatched (orphan) tool_result parts are
 * left untouched for the caller to render with a neutral fallback label.
 */
export function mergeToolResults(messages: SerializedMessage[]): SerializedMessage[] {
  const resultsByToolUseId = new Map<string, { text: string; isError: boolean; index: number }>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.kind === "tool_result") {
        resultsByToolUseId.set(part.toolUseId, {
          text: part.text,
          isError: part.isError,
          index: msg.index,
        });
      }
    }
  }

  const merged: SerializedMessage[] = [];
  for (const msg of messages) {
    const parts: SerializedPart[] = [];
    for (const part of msg.parts) {
      if (part.kind === "tool_use") {
        const result = resultsByToolUseId.get(part.id);
        parts.push(result ? { ...part, result } : part);
      } else if (part.kind === "tool_result") {
        // Drop it here only if some tool_use elsewhere claimed it; orphans pass through.
        const matched = [...messages].some((m) =>
          m.parts.some((p) => p.kind === "tool_use" && p.id === part.toolUseId),
        );
        if (!matched) parts.push(part);
      } else {
        parts.push(part);
      }
    }
    if (parts.length > 0) {
      merged.push({ ...msg, parts });
    }
  }
  return merged;
}

const LOCAL_COMMAND_TAG = /<(local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|ide_opened_file|ide_selection|ide_repomap)>/;

/** True if the text contains synthetic content injected by a local slash command. */
export function isLocalCommandText(text: string): boolean {
  return LOCAL_COMMAND_TAG.test(text);
}

/**
 * Drops messages whose text is entirely synthetic content injected by local
 * slash commands (e.g. /clear, /mcp) rather than something the user typed.
 */
export function filterLocalCommandMessages(messages: SerializedMessage[]): SerializedMessage[] {
  return messages.filter((msg) => {
    const textParts = msg.parts.filter((p) => p.kind === "text");
    if (textParts.length === 0 || textParts.length !== msg.parts.length) return true;
    return !textParts.every((p) => LOCAL_COMMAND_TAG.test(p.text));
  });
}
