import type { SessionMeta } from "./types.js";

export function buildResumeCommand(
  meta: Pick<SessionMeta, "sessionId" | "projectPath">,
): string {
  const resume = `claude --resume ${meta.sessionId}`;
  if (!meta.projectPath) return resume;
  const quoted = `"${meta.projectPath.replace(/"/g, '\\"')}"`;
  return `cd ${quoted} && ${resume}`;
}
