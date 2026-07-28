import * as fs from "node:fs";
import * as path from "node:path";

export interface SubagentMeta {
  agentId: string;
  description: string;
  agentType: string;
  isFork: boolean;
  spawnDepth: number;
  jsonlPath: string;
}

function subagentsDir(sessionId: string, sessionFilePath: string): string {
  return path.join(path.dirname(sessionFilePath), sessionId, "subagents");
}

export function countSubagents(sessionId: string, sessionFilePath: string): number {
  const dir = subagentsDir(sessionId, sessionFilePath);
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".meta.json")).length;
  } catch {
    return 0;
  }
}

export function readSubagents(sessionId: string, sessionFilePath: string): SubagentMeta[] {
  const dir = subagentsDir(sessionId, sessionFilePath);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".meta.json"));
  } catch {
    return [];
  }
  const result: SubagentMeta[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<string, unknown>;
      const agentId = file.replace(/\.meta\.json$/, "");
      result.push({
        agentId,
        description: typeof raw.description === "string" ? raw.description : agentId,
        agentType: typeof raw.agentType === "string" ? raw.agentType : "unknown",
        isFork: raw.isFork === true,
        spawnDepth: typeof raw.spawnDepth === "number" ? raw.spawnDepth : 1,
        jsonlPath: path.join(dir, `${agentId}.jsonl`),
      });
    } catch {
      // skip malformed entries
    }
  }
  return result;
}
