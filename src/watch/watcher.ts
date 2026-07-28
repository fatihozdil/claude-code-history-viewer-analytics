import * as vscode from "vscode";
import { createRefireGate, MIN_REFIRE_MS } from "./refireGate.js";

export type WatcherCallback = () => void;

export { MIN_REFIRE_MS };

/**
 * Set up a filesystem watcher on the project's .jsonl files.
 * Debounces bursts (Claude may write many lines quickly) before triggering,
 * then suppresses further fires for `minRefireMs` so sustained churn (e.g.
 * a long streaming response rewriting the same .jsonl file) can't trigger
 * back-to-back index passes. Events during the suppression window schedule
 * exactly one trailing fire once it ends.
 */
export function startWatcher(
  projectsRoot: string,
  onChanged: WatcherCallback,
  debounceMs: number = 500,
  minRefireMs: number = MIN_REFIRE_MS,
  patternStr: string = "**/*.jsonl",
): vscode.Disposable {
  // Watch all files matching the pattern across the projects root.
  const pattern = new vscode.RelativePattern(
    vscode.Uri.file(projectsRoot),
    patternStr,
  );

  const watcher = vscode.workspace.createFileSystemWatcher(
    pattern,
    false, // ignoreCreateEvents: false
    false, // ignoreChangeEvents: false
    false, // ignoreDeleteEvents: false
  );

  const gate = createRefireGate(onChanged, debounceMs, minRefireMs);

  watcher.onDidCreate(() => gate.trigger());
  watcher.onDidChange(() => gate.trigger());
  watcher.onDidDelete(() => gate.trigger());

  const originalDispose = watcher.dispose.bind(watcher);
  watcher.dispose = () => {
    gate.dispose();
    originalDispose();
  };

  return watcher;
}
