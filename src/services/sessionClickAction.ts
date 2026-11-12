/** What a plain click on a session card does. Mirrors `claudeHistory.defaultClickAction`. */
export const SESSION_CLICK_ACTIONS = ["viewer", "claudeTab", "terminal"] as const;
export type SessionClickAction = (typeof SESSION_CLICK_ACTIONS)[number];

/**
 * Resolve the configured click action for one session.
 *
 * Anything other than a known value falls back to the viewer, so a hand-edited
 * settings.json can never make clicking a session do nothing. "claudeTab" only
 * exists for Claude sessions (the context menu offers it for no other provider),
 * so for Codex and Antigravity it falls back to the viewer as well.
 */
export function resolveClickAction(setting: unknown, provider: string): SessionClickAction {
  if (setting === "terminal") return "terminal";
  if (setting === "claudeTab" && provider === "claude") return "claudeTab";
  return "viewer";
}
