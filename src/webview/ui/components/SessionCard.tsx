// src/webview/ui/components/SessionCard.tsx
import { useState, useRef, useEffect } from "preact/hooks";
import type { SessionCard, SubagentMeta } from "../types.js";
import { formatExpanded, formatCompact, absoluteTime } from "../format.js";
import { ProviderLogo } from "./ProviderLogo.js";

function focusSibling(el: HTMLElement, dir: 1 | -1) {
  const next = dir === 1 ? el.nextElementSibling : el.previousElementSibling;
  if (next instanceof HTMLElement) next.focus();
}

/** Interactive count pill in the metadata line (branches / subagents). */
function CountBadge({
  cls, glyph, label, title, collapsed, onToggle,
}: {
  cls: string;
  glyph: string;
  label: string;
  title: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <span
      class={cls}
      title={title}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); e.stopPropagation(); onToggle();
        }
      }}
    >
      {glyph} {label}
      <span class="session-card__badge-chevron">{collapsed ? "▸" : "▾"}</span>
    </span>
  );
}

const POSSIBLE_FORK_TITLE =
  "Likely forked from the session above — matched by identical first messages. " +
  "IDE forks carry no fork metadata, so this link is a heuristic.";

interface Props {
  card: SessionCard;
  compact: boolean;
  searchActive?: boolean;
  isBranch: boolean;
  isPossibleFork: boolean;
  branchCount: number;
  isBranchCollapsed: boolean;
  onToggleBranches: () => void;
  subagentCount: number;
  isSubagentCollapsed: boolean;
  onToggleSubagents: () => void;
  onClick: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onContextMenu: (x: number, y: number) => void;
  onRename: (sessionId: string, title: string) => void;
}

const PROVIDER_LABEL: Record<SessionCard["provider"], string> = {
  claude: "Claude",
  codex: "Codex",
  agy: "Antigravity",
};

function ProviderBadge({ provider }: { provider: SessionCard["provider"] }) {
  return <span class={`session-card__provider session-card__provider--${provider}`}><ProviderLogo provider={provider} className="session-card__provider-logo" />{PROVIDER_LABEL[provider]}</span>;
}

export function SessionCardView({
  card, compact, searchActive, isBranch, isPossibleFork, branchCount, isBranchCollapsed, onToggleBranches,
  subagentCount, isSubagentCollapsed, onToggleSubagents,
  onClick, onArchive, onUnarchive, onPin, onUnpin, onContextMenu, onRename,
}: Props) {
  const icon = isBranch
    ? "git-branch"
    : card.archived ? "archive"
    : card.pinned ? "pinned"
    : "comment-discussion";
  const meta = compact ? formatCompact(card) : formatExpanded(card);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(card.title || "Untitled");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.select();
  }, [editing]);

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== card.title) onRename(card.sessionId, trimmed);
    setEditing(false);
    setEditValue(card.title || "Untitled");
  };

  const cancelRename = () => {
    setEditing(false);
    setEditValue(card.title || "Untitled");
  };

  let cls = "session-card";
  if (card.archived) cls += " session-card--archived";
  if (card.pinned) cls += " session-card--pinned";
  if (compact) cls += " session-card--compact";
  if (isBranch) cls += " session-card--branch";
  if (isPossibleFork) cls += " session-card--possible-fork";
  cls += ` session-card--provider-${card.provider}`;

  const tooltip = absoluteTime(card.updatedAt || card.createdAt);

  return (
    <div
      class={cls}
      role="button"
      tabIndex={0}
      title={editing ? undefined : tooltip}
      aria-label={`${card.title || "Untitled"}${isPossibleFork ? " (possible fork)" : isBranch ? " (branch)" : ""}${card.pinned ? " (pinned)" : ""}${card.archived ? " (archived)" : ""}`}
      onClick={editing ? undefined : onClick}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e.clientX, e.clientY); }}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); }
        else if (e.key === "ArrowDown") { e.preventDefault(); focusSibling(e.currentTarget as HTMLElement, 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); focusSibling(e.currentTarget as HTMLElement, -1); }
      }}
    >
      <span class={`session-card__icon codicon codicon-${icon}`} />

      <div class="session-card__body">
        {editing ? (
          <input
            ref={inputRef}
            class="session-card__title-input"
            value={editValue}
            onInput={(e) => setEditValue(e.currentTarget.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitRename(); }
              else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
            <div class="session-card__title" data-meta={compact ? meta : undefined} style="flex: 1; min-width: 0;">
              {card.title || "Untitled"}
            </div>
            <ProviderBadge provider={card.provider} />
            {compact && isPossibleFork && (
              <span class="session-card__possible-badge" title={POSSIBLE_FORK_TITLE}>⑂?</span>
            )}
            {compact && branchCount > 0 && (
              <CountBadge
                cls="session-card__branch-badge"
                glyph="⑂"
                label={String(branchCount)}
                title={isBranchCollapsed ? `Show ${branchCount} branches` : "Hide branches"}
                collapsed={isBranchCollapsed}
                onToggle={onToggleBranches}
              />
            )}
            {compact && subagentCount > 0 && (
              <CountBadge
                cls="session-card__subagent-badge"
                glyph="⚡"
                label={String(subagentCount)}
                title={isSubagentCollapsed ? `Show ${subagentCount} subagents` : "Hide subagents"}
                collapsed={isSubagentCollapsed}
                onToggle={onToggleSubagents}
              />
            )}
          </div>
        )}
        {!compact && !editing && (
          <div class="session-card__meta">
            {isPossibleFork && (
              <>
                <span class="session-card__possible-badge" title={POSSIBLE_FORK_TITLE}>
                  ⑂ possible fork
                </span>
                {" · "}
              </>
            )}
            {branchCount > 0 && (
              <>
                <CountBadge
                  cls="session-card__branch-badge"
                  glyph="⑂"
                  label={`${branchCount} branch${branchCount !== 1 ? "es" : ""}`}
                  title={isBranchCollapsed ? `Show ${branchCount} branches` : "Hide branches"}
                  collapsed={isBranchCollapsed}
                  onToggle={onToggleBranches}
                />
                {" · "}
              </>
            )}
            {subagentCount > 0 && (
              <>
                <CountBadge
                  cls="session-card__subagent-badge"
                  glyph="⚡"
                  label={`${subagentCount} subagent${subagentCount !== 1 ? "s" : ""}`}
                  title={isSubagentCollapsed ? `Show ${subagentCount} subagents` : "Hide subagents"}
                  collapsed={isSubagentCollapsed}
                  onToggle={onToggleSubagents}
                />
                {" · "}
              </>
            )}
            {searchActive && (card.matchCount ?? 0) > 1 && (
              <span class="session-card__match-badge">{card.matchCount} matches · </span>
            )}
            {meta}
          </div>
        )}
        {searchActive && !editing && card.matchSnippet && (
          <div class="session-card__snippet">
            {card.matchSnippet.map((part, i) =>
              part.match ? <mark key={i}>{part.text}</mark> : part.text,
            )}
          </div>
        )}
      </div>

      <div class="session-card__actions">
        <button class="session-card__action codicon codicon-edit"
          onClick={(e) => { e.stopPropagation(); setEditValue(card.title || "Untitled"); setEditing(true); }}
          title="Rename" />
        {card.archived ? (
          <button class="session-card__action codicon codicon-history"
            onClick={(e) => { e.stopPropagation(); onUnarchive(); }}
            title="Unarchive"
            aria-label="Unarchive session" />
        ) : (
          <button class="session-card__action codicon codicon-archive"
            onClick={(e) => { e.stopPropagation(); onArchive(); }}
            title="Archive"
            aria-label="Archive session" />
        )}
        {card.pinned ? (
          <button class="session-card__action codicon codicon-pinned"
            onClick={(e) => { e.stopPropagation(); onUnpin(); }}
            title="Unpin"
            aria-label="Unpin session" />
        ) : (
          <button class="session-card__action codicon codicon-pin"
            onClick={(e) => { e.stopPropagation(); onPin(); }}
            title="Pin"
            aria-label="Pin session" />
        )}
      </div>
    </div>
  );
}

interface SubagentProps {
  agent: SubagentMeta;
  compact: boolean;
  onClick: () => void;
}

export function SubagentCardView({ agent, compact, onClick }: SubagentProps) {
  const typeLower = (agent.agentType || "").toLowerCase();
  const idLower = (agent.agentId || "").toLowerCase();
  const descLower = (agent.description || "").toLowerCase();
  const isAgy = typeLower.includes("antigravity") || typeLower.includes("agy") ||
                idLower.includes("antigravity") || idLower.includes("agy") ||
                descLower.includes("antigravity") || descLower.includes("agy");

  const icon = isAgy ? "rocket" : (agent.isFork ? "repo-forked" : "robot");
  const label = agent.description || agent.agentId;
  const subtitle = `${isAgy ? "Antigravity Plugin" : agent.agentType} · depth ${agent.spawnDepth}`;

  let cls = "session-card session-card--subagent";
  if (isAgy) cls += " session-card--antigravity";
  if (compact) cls += " session-card--compact";

  return (
    <div
      class={cls}
      role="button"
      tabIndex={0}
      title={label}
      aria-label={`Subagent: ${label}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); }
        else if (e.key === "ArrowDown") { e.preventDefault(); focusSibling(e.currentTarget as HTMLElement, 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); focusSibling(e.currentTarget as HTMLElement, -1); }
      }}
    >
      <span class={`session-card__icon codicon codicon-${icon}`} />
      <div class="session-card__body">
        <div class="session-card__title" data-meta={compact ? subtitle : undefined}>{label}</div>
        {!compact && <div class="session-card__meta">{subtitle}</div>}
      </div>
    </div>
  );
}
