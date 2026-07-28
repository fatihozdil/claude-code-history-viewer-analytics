// src/webview/ui/components/SessionList.tsx
import { useState } from "preact/hooks";
import type { SessionCard, SubagentMeta } from "../types.js";
import { SessionCardView, SubagentCardView } from "./SessionCard.js";

interface Props {
  sessions: SessionCard[];
  compact: boolean;
  searchActive: boolean;
  subagentCache: Map<string, SubagentMeta[] | "loading">;
  onOpen: (card: SessionCard) => void;
  onOpenSubagent: (filePath: string, title: string) => void;
  onGetSubagents: (sessionId: string) => void;
  onCollapseSubagents: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  onUnarchive: (sessionId: string) => void;
  onPin: (sessionId: string) => void;
  onUnpin: (sessionId: string) => void;
  onContextMenu: (card: SessionCard, x: number, y: number) => void;
  onRename: (sessionId: string, title: string) => void;
}

export function SessionList({
  sessions, compact, searchActive, subagentCache,
  onOpen, onOpenSubagent, onGetSubagents, onCollapseSubagents,
  onArchive, onUnarchive, onPin, onUnpin, onContextMenu, onRename,
}: Props) {
  // expandedBranchParents: root sessionIds whose branch panel is open
  const [expandedBranchParents, setExpandedBranchParents] = useState<Set<string>>(new Set());
  // expandedSubagentParents: set of sessionIds whose subagent list is open
  const [expandedSubagentParents, setExpandedSubagentParents] = useState<Set<string>>(new Set());

  const toggleBranches = (sessionId: string) => {
    setExpandedBranchParents((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const toggleSubagents = (sessionId: string) => {
    if (expandedSubagentParents.has(sessionId)) {
      setExpandedSubagentParents((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      onCollapseSubagents(sessionId);
    } else {
      setExpandedSubagentParents((prev) => new Set([...prev, sessionId]));
      onGetSubagents(sessionId);
    }
  };

  const presentIds = new Set(sessions.map((c) => c.sessionId));

  const rows: JSX.Element[] = [];

  // Branch cards are buffered and rendered in a tinted panel under their root,
  // toggled by the root's branch badge — mirroring the subagent panel.
  let branchBuf: JSX.Element[] = [];
  let rootId: string | null = null;

  const flushBranches = () => {
    if (branchBuf.length && rootId && (searchActive || expandedBranchParents.has(rootId))) {
      rows.push(
        <div key={`branch-group-${rootId}`} class="branch-group">
          {branchBuf}
        </div>,
      );
    }
    branchBuf = [];
  };

  // Push the subagent panel for a card into the given target list, if expanded.
  const pushSubagentPanel = (card: SessionCard, target: JSX.Element[]) => {
    if (searchActive || !expandedSubagentParents.has(card.sessionId)) return;
    const cached = subagentCache.get(card.sessionId);
    if (cached === "loading") {
      target.push(
        <div key={`${card.sessionId}-subagents-loading`} class="subagent-group">
          <div class="session-card session-card--subagent session-card--loading">
            <span class="codicon codicon-loading codicon-modifier-spin" />
            <span style="margin-left: 8px; opacity: 0.6;">Loading subagents…</span>
          </div>
        </div>,
      );
    } else if (Array.isArray(cached)) {
      target.push(
        <div key={`${card.sessionId}-subagents`} class="subagent-group">
          {cached.map((agent) => (
            <SubagentCardView
              key={`${card.sessionId}-${agent.agentId}`}
              agent={agent}
              compact={compact}
              onClick={() => onOpenSubagent(agent.jsonlPath, agent.description || agent.agentId)}
            />
          ))}
        </div>,
      );
    }
  };

  for (const card of sessions) {
    // Exact forkedFrom parent wins; heuristic IDE-fork parent is the fallback.
    const effectiveParentId = card.parentSessionId ?? card.possibleParentId;
    const isBranch = effectiveParentId !== null && presentIds.has(effectiveParentId);
    const isPossibleFork = isBranch && card.parentSessionId === null;

    const cardEl = (
      <SessionCardView
        key={card.sessionId}
        card={card}
        compact={compact}
        searchActive={searchActive}
        isBranch={isBranch}
        isPossibleFork={isPossibleFork}
        branchCount={card.branchCount}
        isBranchCollapsed={!expandedBranchParents.has(card.sessionId)}
        onToggleBranches={() => toggleBranches(card.sessionId)}
        subagentCount={card.subagentCount}
        isSubagentCollapsed={!expandedSubagentParents.has(card.sessionId)}
        onToggleSubagents={() => toggleSubagents(card.sessionId)}
        onClick={() => onOpen(card)}
        onArchive={() => onArchive(card.sessionId)}
        onUnarchive={() => onUnarchive(card.sessionId)}
        onPin={() => onPin(card.sessionId)}
        onUnpin={() => onUnpin(card.sessionId)}
        onContextMenu={(x, y) => onContextMenu(card, x, y)}
        onRename={onRename}
      />
    );

    if (isBranch) {
      branchBuf.push(cardEl);
      pushSubagentPanel(card, branchBuf);
    } else {
      flushBranches();
      rootId = card.sessionId;
      rows.push(cardEl);
      pushSubagentPanel(card, rows);
    }
  }
  flushBranches();

  return <div class="session-list">{rows}</div>;
}
