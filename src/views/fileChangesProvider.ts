import * as path from "node:path";
import * as vscode from "vscode";
import type { FileOperation } from "../claude/types.js";
import { dedupedFileChanges, type FileChangeWithBackup } from "../services/fileChangeService.js";

const OP_ICONS: Record<FileOperation, string> = {
  Read: "eye",
  Write: "edit",
  Edit: "diff",
  MultiEdit: "multiple-windows",
};

class FileChangeNode extends vscode.TreeItem {
  constructor(public readonly change: FileChangeWithBackup) {
    super(path.basename(change.filePath), vscode.TreeItemCollapsibleState.None);
    this.description = `${change.operation} · ${change.filePath}`;
    this.tooltip = `${change.operation} ${change.filePath}${change.timestamp ? ` at ${change.timestamp}` : ""}`;
    this.iconPath = new vscode.ThemeIcon(
      OP_ICONS[change.operation] || "file",
    );
    this.contextValue = "fileChange";
    // Inline open-file command
    this.command = {
      command: "claudeHistory.openFile",
      title: "Open File",
      arguments: [change.filePath],
    };
  }
}

export class FileChangesProvider
  implements vscode.TreeDataProvider<FileChangeNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    FileChangeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private changes: FileChangeWithBackup[] = [];
  private _sessionId = "";

  get sessionId(): string {
    return this._sessionId;
  }

  /** Populate the view with file changes for a session. */
  showSession(sessionId: string): void {
    this._sessionId = sessionId;
    this.changes = dedupedFileChanges(sessionId);
    this._onDidChangeTreeData.fire();
  }

  clear(): void {
    this._sessionId = "";
    this.changes = [];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FileChangeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<FileChangeNode[]> {
    return this.changes.map((c) => new FileChangeNode(c));
  }
}
