export type ProviderFilter = "all" | "claude" | "codex" | "agy" | "deepseek";

export function providerFilterSql(filter: ProviderFilter): string {
  switch (filter) {
    case "codex": return "s.provider = 'codex'";
    case "agy": return "s.provider = 'agy'";
    case "deepseek": return "s.provider = 'claude' AND EXISTS (SELECT 1 FROM messages dm WHERE dm.session_id = s.session_id AND LOWER(COALESCE(dm.model, '')) LIKE '%deepseek%')";
    case "claude": return "s.provider = 'claude' AND NOT EXISTS (SELECT 1 FROM messages cm WHERE cm.session_id = s.session_id AND LOWER(COALESCE(cm.model, '')) LIKE '%deepseek%')";
    default: return "1 = 1";
  }
}
